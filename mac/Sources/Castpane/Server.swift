import Foundation
import CastpaneCore

/// Where the bundled server lives. In a built Castpane.app: Contents/Resources/node,
/// server and web. For development, CASTPANE_NODE, CASTPANE_SERVER_START and
/// CASTPANE_WEB_DIST_DIR point elsewhere (only read when the app is not in a bundle).
struct ServerResources {
    let node: URL
    let start: URL
    let web: URL

    static func find() -> ServerResources? {
        let env = ProcessInfo.processInfo.environment
        if Bundle.main.bundleURL.pathExtension != "app",
           let node = env["CASTPANE_NODE"], let start = env["CASTPANE_SERVER_START"] {
            return ServerResources(node: URL(fileURLWithPath: node), start: URL(fileURLWithPath: start),
                                   web: URL(fileURLWithPath: env["CASTPANE_WEB_DIST_DIR"] ?? ""))
        }
        guard let res = Bundle.main.resourceURL else { return nil }
        let r = ServerResources(node: res.appendingPathComponent("node/bin/node"),
                                start: res.appendingPathComponent("server/start.js"),
                                web: res.appendingPathComponent("web"))
        let fm = FileManager.default
        guard fm.isExecutableFile(atPath: r.node.path), fm.fileExists(atPath: r.start.path) else { return nil }
        return r
    }
}

/// Runs the castpane server (bundled Node on server/start.js), starts it again with
/// backoff when it exits, and stops it when the app quits.
@MainActor
final class ServerSupervisor {
    enum State: Equatable {
        case stopped, missing, running, waiting(TimeInterval), failed(String)

        var summary: String {
            switch self {
            case .stopped: return "Stopped"
            case .missing: return "Not included in this build"
            case .running: return "Running"
            case .waiting(let s): return "Stopped; starting again in \(Int(s)) s"
            case .failed(let m): return "Could not start: \(m)"
            }
        }
    }

    private let paths: Paths
    private let log: LogFile
    private let child: Child
    private var backoff = Backoff(base: 1, cap: 60, stableAfter: 60)
    private var wanted = false
    private var pendingRestart: DispatchWorkItem?
    private var generation = 0
    private(set) var port = AppConfig.defaultPort
    private(set) var publicOrigin = ""

    var onState: ((State) -> Void)?
    private(set) var state: State = .stopped { didSet { if state != oldValue { onState?(state) } } }

    init(paths: Paths) {
        self.paths = paths
        self.log = LogFile(paths.serverLog)
        child = Child(name: "server", records: ChildRecords(folder: paths.children))
    }

    /// Starts the server, or restarts it when the port or address changed.
    func run(port: Int, publicOrigin: String) {
        let changed = port != self.port || publicOrigin != self.publicOrigin
        self.port = port
        self.publicOrigin = publicOrigin
        if wanted && child.isRunning && !changed { return }
        wanted = true
        backoff.reset()
        launch()
    }

    /// Stops the server; await the result to know it has exited.
    @discardableResult
    func stop() -> Task<Void, Never> {
        wanted = false
        pendingRestart?.cancel()
        generation += 1
        state = .stopped
        return child.stop()
    }

    /// The previous server is let go of at once and the next one starts once it has
    /// exited (it holds the port until then); the main thread never waits for it.
    private func launch() {
        pendingRestart?.cancel()
        generation += 1
        let mine = generation
        let previous = child.stop()
        Task {
            await previous.value
            guard self.wanted, mine == self.generation else { return }
            self.spawn(generation: mine)
        }
    }

    private func spawn(generation mine: Int) {
        guard let res = ServerResources.find() else { state = .missing; return }
        let env: [String: String] = [
            "CASTPANE_HOME": paths.home.path,
            "CASTPANE_PORT": String(port),
            "CASTPANE_PUBLIC_ORIGIN": publicOrigin,
            "CASTPANE_WEB_DIST": res.web.path,
            "NODE_ENV": "production",
            // The server stops when its stdin, our pipe, closes: it never outlives the app.
            "CASTPANE_EXIT_ON_STDIN_EOF": "1",
            // A clean environment: nothing from the user's shell (NODE_OPTIONS and the
            // like) reaches the server.
            "HOME": FileManager.default.homeDirectoryForCurrentUser.path,
            "PATH": "/usr/bin:/bin:/usr/sbin:/sbin",
            "LANG": ProcessInfo.processInfo.environment["LANG"] ?? "en_US.UTF-8",
            "TMPDIR": NSTemporaryDirectory(),
            "USER": NSUserName(),
        ]
        do {
            try child.launch(res.node, [res.start.path], environment: env, directory: res.start.deletingLastPathComponent(),
                             log: log) { [weak self] _, ran in
                self?.exited(generation: mine, ran: ran)
            }
            state = .running
        } catch {
            state = .failed(error.localizedDescription)
            scheduleRestart(generation: mine, ran: 0)
        }
    }

    private func exited(generation mine: Int, ran: TimeInterval) {
        guard wanted, mine == generation else { return }
        scheduleRestart(generation: mine, ran: ran)
    }

    private func scheduleRestart(generation mine: Int, ran: TimeInterval) {
        let delay = backoff.next(afterRunning: ran)
        state = .waiting(delay)
        let item = DispatchWorkItem { [weak self] in
            MainActor.assumeIsolated {
                guard let self, self.wanted, mine == self.generation else { return }
                self.launch()
            }
        }
        pendingRestart = item
        DispatchQueue.main.asyncAfter(deadline: .now() + delay, execute: item)
    }
}

/// The server's /api/local/*: from 127.0.0.1, with local.token.
struct LocalAPI {
    let port: Int
    let token: String

    enum Failure: Error, LocalizedError {
        case unreachable, status(Int, String?)
        var errorDescription: String? {
            switch self {
            case .unreachable: return "The castpane server is not answering."
            case .status(let code, let message): return message ?? "The server answered \(code)."
            }
        }
    }

    private static let session: URLSession = {
        let c = URLSessionConfiguration.ephemeral
        c.timeoutIntervalForRequest = 30  // each request sets its own, 5 s unless it waits on another Mac
        c.connectionProxyDictionary = [:]
        return URLSession(configuration: c)
    }()

    private func request(_ method: String, _ path: String, body: [String: Any]? = nil, timeout: TimeInterval = 5) async throws -> Data {
        var r = URLRequest(url: URL(string: "http://127.0.0.1:\(port)/api/local/\(path)")!)
        r.httpMethod = method
        r.timeoutInterval = timeout
        r.setValue("Bearer \(token)", forHTTPHeaderField: "Authorization")
        if let body {
            r.setValue("application/json", forHTTPHeaderField: "Content-Type")
            r.httpBody = try JSONSerialization.data(withJSONObject: body)
        }
        let data: Data, response: URLResponse
        do { (data, response) = try await Self.session.data(for: r) } catch { throw Failure.unreachable }
        let code = (response as? HTTPURLResponse)?.statusCode ?? 0
        guard (200..<300).contains(code) else { throw Failure.status(code, localErrorMessage(data)) }
        return data
    }

    func status() async throws -> LocalStatus {
        guard let s = LocalStatus.decode(try await request("GET", "status")) else { throw Failure.status(200, "Unreadable status.") }
        return s
    }

    enum SetupResult { case created, alreadyExists }

    func setup(username: String, password: String) async throws -> SetupResult {
        do {
            _ = try await request("POST", "setup", body: ["username": username, "password": password])
            return .created
        } catch Failure.status(409, _) {
            return .alreadyExists
        }
    }

    func activity(limit: Int = 50) async throws -> [ActivityItem] {
        ActivityItem.decodeList(try await request("GET", "activity?limit=\(limit)"))
    }

    func endViewer() async throws { _ = try await request("POST", "end-viewer", body: [:]) }

    /// This Mac's link to another Mac's Castpane (docs/multi-mac.md).
    func member() async throws -> MemberStatus { MemberStatus.decode(try await request("GET", "member")) }
    /// Waits as long as the server does for the other Mac (10 s), and more: the join is
    /// not reported failed while it may still succeed (the owner's report, 2026-10-29).
    func joinMember(hub: String, code: String) async throws { _ = try await request("POST", "member/join", body: ["hub": hub, "code": code], timeout: 30) }
    func leaveMember() async throws { _ = try await request("POST", "member/leave", body: [:]) }
}
