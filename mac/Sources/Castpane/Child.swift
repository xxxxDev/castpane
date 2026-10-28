import Foundation
import CastpaneCore

/// A log file the children write to: created 0600, started afresh (the old one kept as
/// `.1`) once it passes 5 MB.
final class LogFile: @unchecked Sendable {
    // `handle` is touched on `queue` only.
    private let url: URL
    private var handle: FileHandle?
    private let queue = DispatchQueue(label: "castpane.log")
    private static let limit: UInt64 = 5 << 20

    init(_ url: URL) { self.url = url }

    func write(_ data: Data) {
        queue.async { [self] in
            if handle == nil { handle = open() }
            guard let h = handle else { return }
            if (try? h.offset()) ?? 0 > Self.limit {
                try? h.close()
                let old = url.appendingPathExtension("1")
                try? FileManager.default.removeItem(at: old)
                try? FileManager.default.moveItem(at: url, to: old)
                handle = open()
            }
            try? handle?.write(contentsOf: data)
        }
    }

    func note(_ text: String) {
        let stamp = ISO8601DateFormatter().string(from: Date())
        write(Data("[castpane \(stamp)] \(text)\n".utf8))
    }

    private func open() -> FileHandle? {
        let fd = Darwin.open(url.path, O_WRONLY | O_CREAT | O_APPEND | O_NOFOLLOW, 0o600)
        guard fd >= 0 else { return nil }
        fchmod(fd, 0o600)
        let h = FileHandle(fileDescriptor: fd, closeOnDealloc: true)
        _ = try? h.seekToEnd()
        return h
    }
}

/// One launch of a child: its pid, its output (read on its own queue, cut into lines by
/// its own splitter) and its exit. Everything that touches the pid happens on `queue`,
/// and the pid is reaped there too, so a signal never reaches a process that merely got
/// the same number later.
final class ChildRun: @unchecked Sendable {
    let pid: pid_t
    let startedAt = Date()
    private let name: String
    private let queue: DispatchQueue
    private let stdin: Int32
    private let records: ChildRecords?
    private let log: LogFile
    private let onLine: (@MainActor (String) -> Void)?
    private let onExit: @MainActor (Int32, TimeInterval) -> Void
    private let reader: DispatchSourceRead
    // On `queue` only.
    private var splitter = LineSplitter()
    private var status: Int32?
    private var outputEnded = false
    private var delivered = false
    private var waiters: [CheckedContinuation<Void, Never>] = []

    init(name: String, started: Spawn.Started, records: ChildRecords?, log: LogFile,
         onLine: (@MainActor (String) -> Void)?, onExit: @escaping @MainActor (Int32, TimeInterval) -> Void) {
        self.name = name
        pid = started.pid
        stdin = started.stdin
        self.records = records
        self.log = log
        self.onLine = onLine
        self.onExit = onExit
        queue = DispatchQueue(label: "castpane.child.\(started.pid)")
        _ = fcntl(started.output, F_SETFL, fcntl(started.output, F_GETFL) | O_NONBLOCK)
        reader = DispatchSource.makeReadSource(fileDescriptor: started.output, queue: queue)
        let fd = started.output
        reader.setEventHandler { [weak self] in self?.read(fd) }
        reader.setCancelHandler { Darwin.close(fd) }
    }

    func begin() {
        reader.resume()
        let pid = self.pid
        // Waits for the exit without reaping (WNOWAIT): the pid stays this child's until
        // `queue` reaps it, after which nothing signals it any more.
        Thread.detachNewThread { [self] in
            var info = siginfo_t()
            while waitid(P_PID, id_t(pid), &info, WEXITED | WNOWAIT) != 0 && errno == EINTR {}
            queue.async { self.reap() }
        }
    }

    private func read(_ fd: Int32) {
        var buffer = [UInt8](repeating: 0, count: 65536)
        let n = Darwin.read(fd, &buffer, buffer.count)
        if n > 0 {
            let data = Data(buffer[0..<n])
            log.write(data)
            deliver(splitter.append(data))
        } else if n == 0 || (errno != EAGAIN && errno != EINTR) {
            endOutput()
        }
    }

    private func deliver(_ lines: [String]) {
        guard let onLine, !lines.isEmpty else { return }
        DispatchQueue.main.async { MainActor.assumeIsolated { for l in lines { onLine(l) } } }
    }

    private func endOutput() {
        guard !outputEnded else { return }
        outputEnded = true
        reader.cancel()
        if let last = splitter.finish() { deliver([last]) }
        finishIfDone()
    }

    private func reap() {
        var raw: Int32 = 0
        while waitpid(pid, &raw, 0) < 0 && errno == EINTR {}
        status = Spawn.status(raw)
        Darwin.close(stdin)
        records?.remove(pid: pid)
        // Output normally ends with the process; a grandchild still holding the pipe
        // must not hold the exit back for long.
        queue.asyncAfter(deadline: .now() + 1) { [self] in endOutput() }
        finishIfDone()
    }

    /// The exit reaches the owner after the last line, on the main queue, once.
    private func finishIfDone() {
        guard let status, outputEnded, !delivered else { return }
        delivered = true
        let ran = Date().timeIntervalSince(startedAt)
        let name = self.name, log = self.log, onExit = self.onExit
        DispatchQueue.main.async {
            MainActor.assumeIsolated {
                log.note("\(name) exited with status \(status) after \(Int(ran)) s")
                onExit(status, ran)
            }
        }
        for w in waiters { w.resume() }
        waiters = []
    }

    /// SIGTERM, then SIGKILL after `grace` seconds; returns once it has exited. Never
    /// blocks a thread while it waits.
    func terminate(grace: TimeInterval) async {
        await withCheckedContinuation { (done: CheckedContinuation<Void, Never>) in
            queue.async { [self] in
                if delivered { done.resume(); return }
                waiters.append(done)
                guard status == nil else { return }
                kill(pid, SIGTERM)
                queue.asyncAfter(deadline: .now() + grace) { [self] in
                    if status == nil { kill(pid, SIGKILL) }
                }
            }
        }
    }
}

/// One child process at a time under one name: its output goes to a log and, line by
/// line, to `onLine` (on the main queue); `onExit` gets the status and how long it ran.
@MainActor
final class Child {
    let name: String
    private let records: ChildRecords?
    private var run: ChildRun?

    init(name: String, records: ChildRecords?) {
        self.name = name
        self.records = records
    }

    var isRunning: Bool { run != nil }
    var pid: Int32? { run?.pid }

    func launch(_ executable: URL, _ arguments: [String], environment: [String: String], directory: URL? = nil,
                log: LogFile, onLine: (@MainActor (String) -> Void)? = nil, onExit: @escaping @MainActor (Int32, TimeInterval) -> Void) throws {
        stop()
        // The file the kernel will run, links resolved: what the pid file records and what
        // a later launch compares a left-behind process with.
        let path = executable.resolvingSymlinksInPath().path
        log.note("starting \(name): \(executable.lastPathComponent) \(arguments.joined(separator: " "))")
        let started = try Spawn.start(path, arguments, environment: environment, directory: directory?.path)
        if !started.disclaimed { log.note("\(name) runs under Castpane's privacy responsibility (the system did not take the disclaim)") }
        if let records, let identity = ProcessIdentity.of(started.pid) {
            do { try records.add(ChildRecord(pid: started.pid, name: name, identity: identity)) }
            catch { log.note("could not write the pid file for \(name): \(error)") }
        }
        let pid = started.pid
        let r = ChildRun(name: name, started: started, records: records, log: log, onLine: onLine) { [weak self] status, ran in
            if self?.run?.pid == pid { self?.run = nil }
            onExit(status, ran)
        }
        run = r
        r.begin()
    }

    /// Lets go of the running child at once (a launch right after starts a new one) and
    /// ends it in the background: SIGTERM, then SIGKILL after `grace` seconds. Await the
    /// task to know it has exited; the main thread is never blocked. The exit callback
    /// still runs (the owner ignores it when it asked for the stop).
    @discardableResult
    func stop(grace: TimeInterval = 3) -> Task<Void, Never> {
        guard let r = run else { return Task {} }
        run = nil
        return Task.detached { await r.terminate(grace: grace) }
    }
}

/// Runs a command to the end and returns its status and output (both streams).
@MainActor
func runToEnd(_ executable: URL, _ arguments: [String], environment: [String: String], log: LogFile, records: ChildRecords?,
              onLine: (@MainActor (String) -> Void)? = nil, register: (@MainActor (Child) -> Void)? = nil) async -> (status: Int32, output: String) {
    await withCheckedContinuation { cont in
        let child = Child(name: arguments.prefix(3).joined(separator: " "), records: records)
        let collected = Collected()
        do {
            // Every line arrives before the exit, both on the main queue.
            try child.launch(executable, arguments, environment: environment, log: log, onLine: { line in
                collected.text += line + "\n"
                onLine?(line)
            }, onExit: { status, _ in cont.resume(returning: (status, collected.text)) })
            register?(child)
        } catch {
            cont.resume(returning: (-1, "\(error)"))
        }
    }
}

@MainActor private final class Collected { var text = "" }
