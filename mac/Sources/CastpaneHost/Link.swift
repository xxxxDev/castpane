import Foundation

// The link to the castpane server: a Unix socket in a folder only this user can open,
// one connection at a time. Every frame is [kind: 1 byte][length: 4 bytes, big-endian]
// [payload]. Kind 1 is a JSON message, either way; kind 2 is video, from here only:
// [flags: 1 byte, bit 0 = key frame][timestamp in µs: 8 bytes][H.264 or HEVC Annex B].
// The first message must be {"t":"hello","token":…} with the token from host.token,
// which the app writes for the server; anything else closes the connection.
enum Kind: UInt8 { case json = 1, video = 2 }

final class Link: @unchecked Sendable {
    // fd is immutable; everything mutable below is guarded by `lock`. The descriptor is
    // closed only once both its reader and its writer are done with it, so a number the
    // system hands out again is never read or written by mistake.
    private let fd: Int32
    private let writes = DispatchQueue(label: "castpane.link.write")
    private let lock = NSLock()
    private var closed = false
    private var readerDone = false
    private var writerDone = false
    private var released = false
    private var closeHandler: (@Sendable () -> Void)?
    /// Bytes handed to the socket but not yet written: video waits when this is high.
    private var queued = 0

    init(fd: Int32) {
        self.fd = fd
        var on: Int32 = 1
        setsockopt(fd, SOL_SOCKET, SO_NOSIGPIPE, &on, socklen_t(MemoryLayout<Int32>.size))
    }

    /// Called once, after the link closes (at once if it already has).
    var onClose: (@Sendable () -> Void)? {
        get { lock.withLock { closeHandler } }
        set {
            let runNow = lock.withLock { () -> Bool in
                if closed { return true }
                closeHandler = newValue
                return false
            }
            if runNow { newValue?() }
        }
    }

    var pending: Int { lock.withLock { queued } }

    func send(json: [String: Any]) {
        // NaN or infinity anywhere would make JSONSerialization raise (not throw): checked first.
        guard JSONSerialization.isValidJSONObject(json), let data = try? JSONSerialization.data(withJSONObject: json) else { return }
        send(kind: .json, payload: data)
    }

    func send(kind: Kind, payload: Data) {
        guard payload.count <= Int(UInt32.max) else { return }
        var frame = Data(capacity: payload.count + 5)
        frame.append(kind.rawValue)
        var length = UInt32(payload.count).bigEndian
        withUnsafeBytes(of: &length) { frame.append(contentsOf: $0) }
        frame.append(payload)
        let size = frame.count
        let accepted = lock.withLock { () -> Bool in
            if closed { return false }
            queued += size
            return true
        }
        guard accepted else { return }
        let bytes = frame
        writes.async { [self] in
            defer { lock.withLock { queued -= size } }
            // Closed before this ran: the descriptor may already be shut down; do not use it.
            if isClosed { return }
            if !write(bytes) { close() }
        }
    }

    var isClosed: Bool { lock.withLock { closed } }

    /// Writes all of `bytes` without ever blocking in the kernel: a full socket is waited
    /// on with poll() in short steps, so a close (which macOS does not let wake a blocked
    /// write) ends the wait within a quarter of a second.
    private func write(_ bytes: Data) -> Bool {
        bytes.withUnsafeBytes { raw -> Bool in
            var offset = 0
            while offset < raw.count {
                let n = Darwin.send(fd, raw.baseAddress! + offset, raw.count - offset, MSG_DONTWAIT)
                if n > 0 { offset += n; continue }
                if n < 0 && errno == EINTR { continue }
                guard n < 0 && errno == EAGAIN else { return false }
                var p = pollfd(fd: fd, events: Int16(POLLOUT), revents: 0)
                repeat {
                    if isClosed { return false }
                } while poll(&p, 1, 250) == 0
            }
            return true
        }
    }

    /// Ends the connection: both directions are shut down at once (which wakes the reader
    /// and any write under way); the descriptor itself is closed when both are done.
    func close() {
        let handler = lock.withLock { () -> (@Sendable () -> Void)?? in
            if closed { return .none }
            closed = true
            defer { closeHandler = nil }
            return .some(closeHandler)
        }
        guard let handler else { return }
        shutdown(fd, SHUT_RDWR)
        // Runs after any write already under way: from here on the writer never touches fd.
        writes.async { [self] in finished(writer: true) }
        handler?()
    }

    private func finished(writer: Bool) {
        let release = lock.withLock { () -> Bool in
            if writer { writerDone = true } else { readerDone = true }
            guard readerDone && writerDone && !released else { return false }
            released = true
            return true
        }
        if release { Darwin.close(fd) }
    }

    /// Reads frames until the connection ends. Runs on its own thread; call it once.
    func readLoop(_ handle: (Kind, Data) -> Void) {
        func readExactly(_ count: Int) -> Data? {
            var data = Data(count: count)
            var offset = 0
            let ok = data.withUnsafeMutableBytes { raw -> Bool in
                while offset < count {
                    let n = read(fd, raw.baseAddress! + offset, count - offset)
                    if n <= 0 { if n < 0 && errno == EINTR { continue }; return false }
                    offset += n
                }
                return true
            }
            return ok ? data : nil
        }
        while !isClosed {
            guard let head = readExactly(5) else { break }
            let length = head[1...4].reduce(UInt32(0)) { $0 << 8 | UInt32($1) }
            guard length <= 1_048_576, let kind = Kind(rawValue: head[0]) else { break }
            guard let payload = length == 0 ? Data() : readExactly(Int(length)) else { break }
            handle(kind, payload)
        }
        close()
        finished(writer: false)
    }
}

/// Listens on `path`, which must sit in a folder that only this user can open. Accepts
/// through a dispatch source, so that `stop()` ends it cleanly (closing a socket that
/// another thread is blocked in accept() on does not wake that thread on macOS).
final class Listener: @unchecked Sendable {
    private let path: String
    private let lock = NSLock()
    private var source: DispatchSourceRead?  // guarded by `lock`
    private let queue = DispatchQueue(label: "castpane.link.accept")

    init(path: String) { self.path = path }

    func start(accept: @escaping @Sendable (Int32) -> Void) throws {
        let dir = (path as NSString).deletingLastPathComponent
        var info = stat()
        guard stat(dir, &info) == 0, info.st_uid == getuid(), info.st_mode & 0o077 == 0 else {
            throw NSError(domain: "Castpane", code: 1, userInfo: [NSLocalizedDescriptionKey: "socket folder must be 0700 and ours: \(dir)"])
        }
        unlink(path)
        let fd = socket(AF_UNIX, SOCK_STREAM, 0)
        guard fd >= 0 else { throw NSError(domain: "Castpane", code: 2) }
        var addr = sockaddr_un()
        addr.sun_family = sa_family_t(AF_UNIX)
        let bytes = Array(path.utf8)
        guard bytes.count < MemoryLayout.size(ofValue: addr.sun_path) else {
            Darwin.close(fd)
            throw NSError(domain: "Castpane", code: 3, userInfo: [NSLocalizedDescriptionKey: "socket path too long"])
        }
        withUnsafeMutableBytes(of: &addr.sun_path) { raw in
            for (i, b) in bytes.enumerated() { raw[i] = b }
            raw[bytes.count] = 0
        }
        let size = socklen_t(MemoryLayout<sockaddr_un>.size)
        let bound = withUnsafePointer(to: &addr) { $0.withMemoryRebound(to: sockaddr.self, capacity: 1) { bind(fd, $0, size) } }
        guard bound == 0 else {
            let code = errno
            Darwin.close(fd)
            throw NSError(domain: "Castpane", code: 4, userInfo: [NSLocalizedDescriptionKey: "bind failed: \(code)"])
        }
        chmod(path, 0o600)
        guard listen(fd, 4) == 0 else { Darwin.close(fd); throw NSError(domain: "Castpane", code: 5) }
        _ = fcntl(fd, F_SETFL, fcntl(fd, F_GETFL) | O_NONBLOCK)
        let src = DispatchSource.makeReadSource(fileDescriptor: fd, queue: queue)
        src.setEventHandler {
            while true {
                let client = Darwin.accept(fd, nil, nil)
                if client < 0 { if errno == EINTR { continue }; return }
                // The connection itself blocks: Link reads it on its own thread.
                _ = fcntl(client, F_SETFL, fcntl(client, F_GETFL) & ~O_NONBLOCK)
                accept(client)
            }
        }
        src.setCancelHandler { Darwin.close(fd) }
        lock.withLock { source = src }
        src.resume()
    }

    /// Stops accepting and removes the socket file: the server then sees no Castpane.
    func stop() {
        let src = lock.withLock { () -> DispatchSourceRead? in defer { source = nil }; return source }
        src?.cancel()
        unlink(path)
    }
}
