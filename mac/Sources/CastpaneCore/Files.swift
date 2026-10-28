import Foundation
import Security

/// Where everything Castpane keeps on the Mac lives:
/// `~/Library/Application Support/Castpane/` (0700), owned by the app.
public struct Paths: Sendable {
    public let home: URL

    public init(home: URL) { self.home = home }

    /// The default folder, in the current user's Application Support.
    public static func standard() -> Paths {
        let base = FileManager.default.urls(for: .applicationSupportDirectory, in: .userDomainMask).first
            ?? FileManager.default.homeDirectoryForCurrentUser.appendingPathComponent("Library/Application Support")
        return Paths(home: base.appendingPathComponent("Castpane", isDirectory: true))
    }

    public var config: URL { home.appendingPathComponent("config.json") }
    public var hostSocket: URL { home.appendingPathComponent("host.sock") }
    public var hostToken: URL { home.appendingPathComponent("host.token") }
    public var localToken: URL { home.appendingPathComponent("local.token") }
    public var data: URL { home.appendingPathComponent("data", isDirectory: true) }
    public var cloudflared: URL { home.appendingPathComponent("cloudflared", isDirectory: true) }
    public var logs: URL { home.appendingPathComponent("logs", isDirectory: true) }
    public var serverLog: URL { logs.appendingPathComponent("server.log") }
    public var cloudflaredLog: URL { logs.appendingPathComponent("cloudflared.log") }
    /// One pid file per running child (Node, cloudflared), to end any a crash left behind.
    public var children: URL { home.appendingPathComponent("children", isDirectory: true) }

    /// Creates the folder and its 0700 subfolders, tightening any that are too open.
    public func prepare() throws {
        for dir in [home, data, cloudflared, logs, children] { try SecureFiles.ensureDirectory(dir) }
    }
}

public enum SecureFileError: Error, Equatable, CustomStringConvertible {
    case notOwned(String)
    case notADirectory(String)
    case io(String, Int32)

    public var description: String {
        switch self {
        case .notOwned(let p): return "\(p) belongs to another user"
        case .notADirectory(let p): return "\(p) is not a folder"
        case .io(let p, let e): return "\(p): \(String(cString: strerror(e)))"
        }
    }
}

/// Files only this user can read: written whole (temp file, then rename), 0600 from the
/// moment they exist, in folders that are 0700.
public enum SecureFiles {
    public static func ensureDirectory(_ url: URL, mode: mode_t = 0o700) throws {
        let path = url.path
        var info = stat()
        if lstat(path, &info) != 0 {
            guard errno == ENOENT else { throw SecureFileError.io(path, errno) }
            try FileManager.default.createDirectory(at: url, withIntermediateDirectories: true,
                                                    attributes: [.posixPermissions: NSNumber(value: mode)])
            guard lstat(path, &info) == 0 else { throw SecureFileError.io(path, errno) }
        }
        guard info.st_mode & S_IFMT == S_IFDIR else { throw SecureFileError.notADirectory(path) }
        guard info.st_uid == getuid() else { throw SecureFileError.notOwned(path) }
        if info.st_mode & 0o777 != mode, chmod(path, mode) != 0 { throw SecureFileError.io(path, errno) }
    }

    /// Writes `data` to `url` with `mode`, atomically. A file already there (even one
    /// made more open by someone) is replaced, never written through.
    public static func write(_ data: Data, to url: URL, mode: mode_t = 0o600) throws {
        let dir = url.deletingLastPathComponent().path
        let temp = "\(dir)/.\(url.lastPathComponent).\(UUID().uuidString).tmp"
        let fd = open(temp, O_WRONLY | O_CREAT | O_EXCL | O_NOFOLLOW, mode)
        guard fd >= 0 else { throw SecureFileError.io(temp, errno) }
        var ok = true
        data.withUnsafeBytes { raw in
            var offset = 0
            while offset < raw.count {
                let n = Darwin.write(fd, raw.baseAddress! + offset, raw.count - offset)
                if n < 0 { if errno == EINTR { continue }; ok = false; return }
                offset += n
            }
        }
        let saved = errno
        if ok { fchmod(fd, mode); fsync(fd) }
        close(fd)
        guard ok else { unlink(temp); throw SecureFileError.io(temp, saved) }
        guard rename(temp, url.path) == 0 else { let e = errno; unlink(temp); throw SecureFileError.io(url.path, e) }
    }

    /// The file's permission bits, or nil if it is missing.
    public static func mode(of url: URL) -> mode_t? {
        var info = stat()
        guard stat(url.path, &info) == 0 else { return nil }
        return info.st_mode & 0o7777
    }

    /// A token from a file that is ours and 0600 (or tighter), or nil.
    public static func readToken(_ url: URL) -> String? {
        var info = stat()
        guard stat(url.path, &info) == 0, info.st_uid == getuid(), info.st_mode & 0o077 == 0,
              let text = try? String(contentsOf: url, encoding: .utf8) else { return nil }
        let token = text.trimmingCharacters(in: .whitespacesAndNewlines)
        return token.count >= 32 ? token : nil
    }

    /// 32 random bytes as 64 hex characters.
    public static func newToken() -> String {
        var bytes = [UInt8](repeating: 0, count: 32)
        let status = SecRandomCopyBytes(kSecRandomDefault, bytes.count, &bytes)
        precondition(status == errSecSuccess, "no random bytes")
        return bytes.map { String(format: "%02x", $0) }.joined()
    }
}
