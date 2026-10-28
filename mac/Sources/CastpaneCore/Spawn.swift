import Foundation
import Darwin

/// Starts a child process with posix_spawn, the way the app wants its children:
///
/// - only stdin, stdout and stderr reach it (POSIX_SPAWN_CLOEXEC_DEFAULT): no socket,
///   log or token file the app has open leaks into Node or cloudflared;
/// - default signal handlers and no blocked signals;
/// - when the system offers it, macOS is told the child is responsible for itself
///   (`responsibility_spawnattrs_setdisclaim`), so it does not run under Castpane's
///   Screen Recording and Accessibility grants, and any privacy prompt names it rather
///   than Castpane.
public enum Spawn {
    public struct Started: Sendable {
        public let pid: pid_t
        /// The write end of the child's stdin: held open, never written. The child sees
        /// the end of its input when this app closes it or is gone.
        public let stdin: Int32
        /// The read end of the child's stdout and stderr, both on one pipe.
        public let output: Int32
        /// Whether macOS was told the child is responsible for itself.
        public let disclaimed: Bool
    }

    public struct Failure: Error, CustomStringConvertible {
        public let call: String
        public let code: Int32
        public var description: String { "\(call): \(String(cString: strerror(code)))" }
    }

    private typealias Disclaim = @convention(c) (UnsafeMutablePointer<posix_spawnattr_t?>, Int32) -> Int32
    private typealias Responsible = @convention(c) (pid_t) -> pid_t

    /// A private but long-standing libSystem call (used by terminals, IDEs and browsers to
    /// start helpers). Looked up at run time: on a system without it, children simply
    /// stay attributed to the app.
    private static let disclaim: Disclaim? = {
        guard let sym = dlsym(UnsafeMutableRawPointer(bitPattern: -2), "responsibility_spawnattrs_setdisclaim") else { return nil }
        return unsafeBitCast(sym, to: Disclaim.self)
    }()

    private static let responsibleFor: Responsible? = {
        guard let sym = dlsym(UnsafeMutableRawPointer(bitPattern: -2), "responsibility_get_pid_responsible_for_pid") else { return nil }
        return unsafeBitCast(sym, to: Responsible.self)
    }()

    /// The process macOS holds responsible for `pid` (for privacy prompts and grants), when
    /// the system says.
    public static func responsiblePID(for pid: pid_t) -> pid_t? {
        guard let f = responsibleFor else { return nil }
        let r = f(pid)
        return r > 0 ? r : nil
    }

    public static func start(_ executable: String, _ arguments: [String], environment: [String: String],
                             directory: String? = nil, disclaimResponsibility: Bool = true) throws -> Started {
        var input: [Int32] = [-1, -1], output: [Int32] = [-1, -1]
        guard pipe(&input) == 0 else { throw Failure(call: "pipe", code: errno) }
        guard pipe(&output) == 0 else {
            let e = errno; Darwin.close(input[0]); Darwin.close(input[1])
            throw Failure(call: "pipe", code: e)
        }
        // The app's own ends are never inherited by anything else it starts.
        for fd in [input[1], output[0]] { _ = fcntl(fd, F_SETFD, FD_CLOEXEC) }
        func closeAll() { for fd in input + output { Darwin.close(fd) } }

        var actions: posix_spawn_file_actions_t?
        posix_spawn_file_actions_init(&actions)
        defer { posix_spawn_file_actions_destroy(&actions) }
        posix_spawn_file_actions_adddup2(&actions, input[0], 0)
        posix_spawn_file_actions_adddup2(&actions, output[1], 1)
        posix_spawn_file_actions_adddup2(&actions, output[1], 2)
        if let directory { posix_spawn_file_actions_addchdir_np(&actions, directory) }

        var attr: posix_spawnattr_t?
        posix_spawnattr_init(&attr)
        defer { posix_spawnattr_destroy(&attr) }
        posix_spawnattr_setflags(&attr, Int16(POSIX_SPAWN_CLOEXEC_DEFAULT | POSIX_SPAWN_SETSIGDEF | POSIX_SPAWN_SETSIGMASK))
        var none = sigset_t(), all = sigset_t()
        sigemptyset(&none)
        sigfillset(&all)
        posix_spawnattr_setsigmask(&attr, &none)
        posix_spawnattr_setsigdefault(&attr, &all)
        var disclaimed = false
        if disclaimResponsibility, let disclaim { disclaimed = disclaim(&attr, 1) == 0 }

        let argv = ([executable] + arguments).map { strdup($0) } + [nil]
        let envp = environment.map { strdup("\($0.key)=\($0.value)") } + [nil]
        defer { for p in argv + envp { free(p) } }

        var pid: pid_t = 0
        let rc = posix_spawn(&pid, executable, &actions, &attr, argv, envp)
        guard rc == 0 else { closeAll(); throw Failure(call: "posix_spawn", code: rc) }
        // The child's ends belong to it now.
        Darwin.close(input[0])
        Darwin.close(output[1])
        return Started(pid: pid, stdin: input[1], output: output[0], disclaimed: disclaimed)
    }

    /// Exit code, or the signal number for a child that a signal ended (as Foundation's
    /// Process reports it).
    public static func status(_ raw: Int32) -> Int32 {
        let signal = raw & 0x7f
        return signal == 0 ? (raw >> 8) & 0xff : signal
    }
}

/// Who a process is, enough to tell it from another that later got the same pid.
public struct ProcessIdentity: Equatable, Sendable, Codable {
    /// Its executable, as the kernel names it.
    public var path: String
    /// When it started, in µs since 1970.
    public var started: UInt64
    public var uid: uid_t
    public var parent: pid_t

    public init(path: String, started: UInt64, uid: uid_t, parent: pid_t) {
        self.path = path
        self.started = started
        self.uid = uid
        self.parent = parent
    }

    /// The live process `pid`, or nil if there is none (or it is not readable).
    public static func of(_ pid: pid_t) -> ProcessIdentity? {
        guard pid > 0 else { return nil }
        var info = proc_bsdinfo()
        let size = Int32(MemoryLayout<proc_bsdinfo>.size)
        guard proc_pidinfo(pid, PROC_PIDTBSDINFO, 0, &info, size) == size else { return nil }
        var buffer = [UInt8](repeating: 0, count: 4 * Int(MAXPATHLEN))
        let length = proc_pidpath(pid, &buffer, UInt32(buffer.count))
        guard length > 0 else { return nil }
        return ProcessIdentity(path: String(decoding: buffer.prefix(Int(length)), as: UTF8.self), started: UInt64(info.pbi_start_tvsec) * 1_000_000 + UInt64(info.pbi_start_tvusec),
                               uid: info.pbi_uid, parent: pid_t(info.pbi_ppid))
    }
}

/// One child the app started, as written to its pid file.
public struct ChildRecord: Equatable, Sendable, Codable {
    public var pid: pid_t
    public var name: String
    public var identity: ProcessIdentity

    public init(pid: pid_t, name: String, identity: ProcessIdentity) {
        self.pid = pid
        self.name = name
        self.identity = identity
    }

    /// Whether `live` (the process now at this pid) is still the child this record is
    /// about, left behind by an app that is gone, and running one of the app's own
    /// executables: the same executable and start time, this user's, orphaned (its
    /// parent is launchd, as when the app that started it crashed), and `isOurs(path)`.
    /// Only then may it be signalled; anything else is left alone.
    public func isStale(_ live: ProcessIdentity?, isOurs: (String) -> Bool) -> Bool {
        guard let live else { return false }
        return live.path == identity.path && live.started == identity.started && live.uid == getuid()
            && live.parent == 1 && isOurs(live.path)
    }
}

/// The pid files of the children that are running: `children/<pid>.json` in Castpane's
/// folder, 0600 in a 0700 folder.
public struct ChildRecords: Sendable {
    public let folder: URL

    public init(folder: URL) { self.folder = folder }

    public func add(_ record: ChildRecord) throws {
        try SecureFiles.ensureDirectory(folder)
        let data = try JSONEncoder().encode(record)
        try SecureFiles.write(data, to: folder.appendingPathComponent("\(record.pid).json"))
    }

    public func remove(pid: pid_t) {
        unlink(folder.appendingPathComponent("\(pid).json").path)
    }

    /// Every record that reads back, with the pid its file is named for.
    public func all() -> [ChildRecord] {
        guard let names = try? FileManager.default.contentsOfDirectory(atPath: folder.path) else { return [] }
        return names.compactMap { name -> ChildRecord? in
            guard name.hasSuffix(".json"), let pid = pid_t(name.dropLast(5)),
                  let data = FileManager.default.contents(atPath: folder.appendingPathComponent(name).path),
                  let record = try? JSONDecoder().decode(ChildRecord.self, from: data), record.pid == pid else { return nil }
            return record
        }
    }

    /// Whether `path` is inside `folder` (both with symbolic links resolved).
    public static func path(_ path: String, isInside folder: URL) -> Bool {
        let base = folder.resolvingSymlinksInPath().standardizedFileURL.path
        let p = URL(fileURLWithPath: path).resolvingSymlinksInPath().standardizedFileURL.path
        return p.hasPrefix(base.hasSuffix("/") ? base : base + "/")
    }
}

/// Ends children a crashed Castpane left behind, from their pid files: only a process that
/// is still exactly the one recorded (same executable, same start time), this user's,
/// orphaned, and running one of `ours` (inside the app or Castpane's cloudflared folder, or
/// the very binary the app would start). Nothing is ever signalled by name.
public enum StaleChildren {
    public static func end(records: ChildRecords, isOurs: @escaping @Sendable (String) -> Bool, note: @escaping @Sendable (String) -> Void) async {
        let found = records.all()
        guard !found.isEmpty else { return }
        await withTaskGroup(of: Void.self) { group in
            for record in found {
                group.addTask {
                    defer { records.remove(pid: record.pid) }
                    guard record.isStale(ProcessIdentity.of(record.pid), isOurs: isOurs) else { return }
                    note("ending \(record.name) (pid \(record.pid)) left behind by an earlier Castpane")
                    kill(record.pid, SIGTERM)
                    for _ in 0..<30 {
                        try? await Task.sleep(nanoseconds: 100_000_000)
                        if ProcessIdentity.of(record.pid) != record.identity.with(parent: 1) { return }
                    }
                    // Still the same process after 3 s: checked once more right before the kill.
                    if record.isStale(ProcessIdentity.of(record.pid), isOurs: isOurs) { kill(record.pid, SIGKILL) }
                }
            }
        }
    }
}

private extension ProcessIdentity {
    func with(parent: pid_t) -> ProcessIdentity { var c = self; c.parent = parent; return c }
}

