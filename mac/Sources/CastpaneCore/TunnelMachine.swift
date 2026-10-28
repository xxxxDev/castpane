import Foundation

/// Where the tunnel is. The own-domain steps (login, create, route, config) run once;
/// after that a start goes straight to `tunnel run`.
public enum TunnelPhase: Equatable, Sendable {
    case off
    case installing
    /// Own domain: no Cloudflare sign-in yet; waits for the user to ask for one.
    case needsLogin
    /// `tunnel login` is running; the page it asks to open, once known.
    case loggingIn(url: String?)
    case creating
    case routing
    /// The tunnel process runs but has no address or connection yet.
    case starting
    /// Quick: the address of this run. Own domain: nil (the address is the domain).
    case running(quickURL: String?)
    case waitingToRestart(seconds: TimeInterval)
    case failed(String)

    public var summary: String {
        switch self {
        case .off: return "Off"
        case .installing: return "Getting cloudflared…"
        case .needsLogin: return "Sign in to Cloudflare to continue"
        case .loggingIn: return "Waiting for the Cloudflare sign-in in the browser…"
        case .creating: return "Creating the tunnel…"
        case .routing: return "Pointing the domain at the tunnel…"
        case .starting: return "Connecting…"
        case .running: return "Connected"
        case .waitingToRestart(let s): return "Stopped; trying again in \(Int(s)) s"
        case .failed(let m): return "Failed: \(m)"
        }
    }
}

/// What the tunnel manager should do next.
public enum TunnelAction: Equatable, Sendable {
    case install
    case runQuick
    case login
    case create
    case route
    case writeConfig
    case runTunnel
    case stopChild
    /// The public address changed: nil while a quick tunnel has none.
    case publishQuickURL(String?)
    case restartAfter(TimeInterval)
}

/// What is already in place on this Mac.
public struct TunnelSetup: Equatable, Sendable {
    public var hasBinary: Bool
    public var hasCert: Bool
    /// config.yml and the credentials file exist and match the chosen host name.
    public var configured: Bool

    public init(hasBinary: Bool, hasCert: Bool, configured: Bool) {
        self.hasBinary = hasBinary
        self.hasCert = hasCert
        self.configured = configured
    }
}

public enum TunnelEvent: Equatable, Sendable {
    /// `interactive`: the user asked just now, so a browser sign-in may open.
    case start(ConnectionMode, TunnelSetup, interactive: Bool)
    /// A start the manager refused before running anything (a host name that is not
    /// one): whatever ran stops and the reason shows.
    case refused(ConnectionMode, String)
    case stop
    case installed
    case installFailed(String)
    /// The user asked to sign in to Cloudflare (again).
    case signIn
    /// A line of output from the running child.
    case output(String)
    case loginFinished(ok: Bool, message: String)
    case created(ok: Bool, message: String)
    case routed(ok: Bool, message: String)
    case configWritten(ok: Bool, message: String)
    /// The supervised tunnel (quick or run) exited after running this long.
    case exited(ranFor: TimeInterval)
    case restartDue
}

/// The quick and own-domain flows as a state machine, free of processes and files so
/// it can be tested on its own. The manager feeds it events and carries out actions.
public struct TunnelMachine: Sendable {
    public private(set) var mode: ConnectionMode = .none
    public private(set) var setup = TunnelSetup(hasBinary: false, hasCert: false, configured: false)
    public private(set) var phase: TunnelPhase = .off
    public private(set) var quickURL: String?
    /// The user asked for a sign-in while cloudflared still had to be downloaded: it opens
    /// once the download is done.
    public private(set) var loginAfterInstall = false
    public var backoff = Backoff(base: 2, cap: 120, stableAfter: 60)

    public init() {}

    public mutating func handle(_ event: TunnelEvent) -> [TunnelAction] {
        switch event {
        case let .start(mode, setup, interactive):
            self.mode = mode
            self.setup = setup
            backoff.reset()
            loginAfterInstall = interactive
            var actions: [TunnelAction] = [.stopChild]
            if quickURL != nil { quickURL = nil; actions.append(.publishQuickURL(nil)) }
            guard mode.usesCloudflared else { phase = .off; return actions }
            return actions + proceed(interactive: interactive)

        case let .refused(mode, message):
            self.mode = mode
            phase = .failed(message)
            backoff.reset()
            var actions: [TunnelAction] = [.stopChild]
            if quickURL != nil { quickURL = nil; actions.append(.publishQuickURL(nil)) }
            return actions

        case .stop:
            phase = .off
            loginAfterInstall = false
            backoff.reset()
            var actions: [TunnelAction] = [.stopChild]
            if quickURL != nil { quickURL = nil; actions.append(.publishQuickURL(nil)) }
            return actions

        case .installed:
            guard phase == .installing else { return [] }
            setup.hasBinary = true
            let interactive = loginAfterInstall
            loginAfterInstall = false
            return proceed(interactive: interactive)

        case .installFailed(let message):
            guard phase == .installing else { return [] }
            loginAfterInstall = false
            phase = .failed("could not get cloudflared: \(message)")
            return []

        case .signIn:
            guard mode == .domain else { return [] }
            setup.hasCert = false
            setup.configured = false
            if !setup.hasBinary {
                loginAfterInstall = true
                if phase == .installing { return [] }
                phase = .installing
                return [.install]
            }
            phase = .loggingIn(url: nil)
            return [.stopChild, .login]

        case .output(let line):
            switch phase {
            case .loggingIn(nil):
                if let url = CloudflaredOutput.loginURL(in: line) { phase = .loggingIn(url: url) }
                return []
            case .starting, .running:
                // The first address of a run is the address: a later, different one in the
                // same run's output (an echo, a log line naming another host) is ignored.
                if mode == .quick, quickURL == nil, let url = CloudflaredOutput.quickURL(in: line) {
                    quickURL = url
                    phase = .running(quickURL: url)
                    return [.publishQuickURL(url)]
                }
                if mode == .domain, phase == .starting, CloudflaredOutput.isConnected(line) {
                    phase = .running(quickURL: nil)
                }
                return []
            default:
                return []
            }

        case let .loginFinished(ok, message):
            guard case .loggingIn = phase else { return [] }
            guard ok else { phase = .failed("Cloudflare sign-in did not finish: \(message)"); return [] }
            setup.hasCert = true
            phase = .creating
            return [.create]

        case let .created(ok, message):
            guard phase == .creating else { return [] }
            guard ok else { phase = .failed("could not create the tunnel: \(message)"); return [] }
            phase = .routing
            return [.route]

        case let .routed(ok, message):
            guard phase == .routing else { return [] }
            guard ok else { phase = .failed("could not point the domain at the tunnel: \(message)"); return [] }
            return [.writeConfig]

        case let .configWritten(ok, message):
            guard phase == .routing else { return [] }
            guard ok else { phase = .failed("could not write config.yml: \(message)"); return [] }
            setup.configured = true
            phase = .starting
            return [.runTunnel]

        case .exited(let ran):
            switch phase {
            case .starting, .running:
                let delay = backoff.next(afterRunning: ran)
                phase = .waitingToRestart(seconds: delay)
                var actions: [TunnelAction] = []
                if quickURL != nil { quickURL = nil; actions.append(.publishQuickURL(nil)) }
                return actions + [.restartAfter(delay)]
            default:
                return []
            }

        case .restartDue:
            guard case .waitingToRestart = phase else { return [] }
            return proceed(interactive: false)
        }
    }

    private mutating func proceed(interactive: Bool) -> [TunnelAction] {
        if !setup.hasBinary { phase = .installing; return [.install] }
        switch mode {
        case .quick:
            phase = .starting
            return [.runQuick]
        case .domain:
            if setup.configured { phase = .starting; return [.runTunnel] }
            if setup.hasCert { phase = .creating; return [.create] }
            if interactive { phase = .loggingIn(url: nil); return [.login] }
            phase = .needsLogin
            return []
        case .none, .tailscale:
            phase = .off
            return []
        }
    }
}
