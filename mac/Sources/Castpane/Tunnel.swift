import Foundation
import CastpaneCore

/// Finds cloudflared, or downloads it from Cloudflare's GitHub releases into
/// cloudflared/bin: the archive and the binary checked against the published SHA-256
/// sums, and the binary's signature checked to be Cloudflare's.
struct CloudflaredInstaller {
    let paths: Paths

    var ownBinary: URL { paths.cloudflared.appendingPathComponent("bin/cloudflared") }

    /// One on the usual PATH places, signed by Cloudflare's team as a download must be;
    /// nothing is copied.
    func onPath() -> URL? {
        // An app started from Finder has a short PATH: look where installers put it too.
        let path = (ProcessInfo.processInfo.environment["PATH"] ?? "").split(separator: ":").map(String.init)
        return CloudflaredRelease.installed(own: nil, searchDirs: path + ["/opt/homebrew/bin", "/usr/local/bin"])
    }

    /// The cloudflared to run: always Castpane's own copy in cloudflared/bin. One on PATH
    /// that differs from it is copied there and the copy checked again
    /// (CloudflaredRelease.adopt), so a `brew upgrade` that removes the original does not
    /// break the next restart, and the next launch takes the new version. Nil when there
    /// is no trusted copy, and it is downloaded.
    func existing(log: LogFile? = nil) -> URL? {
        if let other = onPath(), !FileManager.default.contentsEqual(atPath: other.path, andPath: ownBinary.path) {
            do {
                let own = try CloudflaredRelease.adopt(other, as: ownBinary)
                log?.note("cloudflared copied from \(other.path) and verified")
                return own
            } catch {
                log?.note("cloudflared at \(other.path) not used: \(error)")
            }
        }
        return CloudflaredRelease.installed(own: ownBinary, searchDirs: [])
    }

    enum Failure: Error, LocalizedError {
        case noRelease, download(String), checksum(String), signature, extract
        var errorDescription: String? {
            switch self {
            case .noRelease: return "no cloudflared release with checksums for this Mac"
            case .download(let m): return "download failed (\(m))"
            case .checksum(let which): return "the \(which) does not match its published checksum"
            case .signature: return "the binary is not signed by Cloudflare"
            case .extract: return "could not unpack the archive"
            }
        }
    }

    func install(log: LogFile) async throws -> URL {
        var request = URLRequest(url: CloudflaredRelease.latestAPI)
        request.setValue("application/vnd.github+json", forHTTPHeaderField: "Accept")
        request.setValue("Castpane", forHTTPHeaderField: "User-Agent")
        let (json, response) = try await URLSession.shared.data(for: request)
        guard (response as? HTTPURLResponse)?.statusCode == 200 else { throw Failure.download("release list") }
        guard let asset = CloudflaredRelease.asset(fromReleaseJSON: json) else { throw Failure.noRelease }
        log.note("downloading cloudflared \(asset.tag) from \(asset.url.absoluteString)")

        let work = paths.cloudflared.appendingPathComponent("download-\(UUID().uuidString)", isDirectory: true)
        try SecureFiles.ensureDirectory(work)
        defer { try? FileManager.default.removeItem(at: work) }
        let (temp, got) = try await URLSession.shared.download(from: asset.url)
        guard (got as? HTTPURLResponse)?.statusCode == 200 else { throw Failure.download("HTTP \((got as? HTTPURLResponse)?.statusCode ?? 0)") }
        let archive = work.appendingPathComponent("cloudflared.tgz")
        try FileManager.default.moveItem(at: temp, to: archive)
        if let want = asset.archiveSHA256, try CloudflaredRelease.sha256(fileAt: archive) != want { throw Failure.checksum("archive") }

        let tar = Process()
        tar.executableURL = URL(fileURLWithPath: "/usr/bin/tar")
        tar.arguments = ["-xzf", archive.path, "-C", work.path, "cloudflared"]
        try tar.run()
        tar.waitUntilExit()
        let binary = work.appendingPathComponent("cloudflared")
        guard tar.terminationStatus == 0, FileManager.default.fileExists(atPath: binary.path) else { throw Failure.extract }
        if let want = asset.binarySHA256, try CloudflaredRelease.sha256(fileAt: binary) != want { throw Failure.checksum("binary") }
        guard CloudflaredRelease.isSignedByCloudflare(binary) else { throw Failure.signature }

        try SecureFiles.ensureDirectory(ownBinary.deletingLastPathComponent())
        chmod(binary.path, 0o755)
        _ = try? FileManager.default.removeItem(at: ownBinary)
        try FileManager.default.moveItem(at: binary, to: ownBinary)
        log.note("cloudflared \(asset.tag) installed and verified")
        return ownBinary
    }
}

/// Runs cloudflared for the quick and own-domain modes, carrying out what the
/// TunnelMachine decides. Its HOME is cloudflared/, so its sign-in certificate and
/// any config it looks for stay in Castpane's folder, apart from the user's own.
@MainActor
final class TunnelManager {
    private let paths: Paths
    private let log: LogFile
    private var machine = TunnelMachine()
    private let records: ChildRecords
    private let child: Child
    private var oneShot: Child?
    private var binary: URL?
    private var generation = 0
    private var pendingRestart: DispatchWorkItem?

    private(set) var mode: ConnectionMode = .none
    private(set) var hostname = ""
    private(set) var port = AppConfig.defaultPort

    var onPhase: ((TunnelPhase) -> Void)?
    var onQuickURL: ((String?) -> Void)?
    var onLine: ((String) -> Void)?

    var phase: TunnelPhase { machine.phase }

    init(paths: Paths) {
        self.paths = paths
        self.log = LogFile(paths.cloudflaredLog)
        records = ChildRecords(folder: paths.children)
        child = Child(name: "cloudflared", records: records)
    }

    private var installer: CloudflaredInstaller { CloudflaredInstaller(paths: paths) }
    private var dotDir: URL { paths.cloudflared.appendingPathComponent(".cloudflared", isDirectory: true) }
    private var cert: URL { dotDir.appendingPathComponent("cert.pem") }
    private var configFile: URL { paths.cloudflared.appendingPathComponent("config.yml") }
    private var tunnelName: String { Address.tunnelName(computerName: Host.current().localizedName ?? "mac") }
    private var credentials: URL { paths.cloudflared.appendingPathComponent("\(tunnelName).json") }

    /// Whether config.yml and its credentials are in place for this host name.
    private func configured(for host: String) -> Bool {
        guard let text = try? String(contentsOf: configFile, encoding: .utf8),
              let parsed = CloudflaredConfigFile.parse(text) else { return false }
        return parsed.hostname == host.lowercased() && FileManager.default.fileExists(atPath: credentials.path)
    }

    /// (Re)starts for a mode. `interactive` when the user asked just now: only then does a
    /// Cloudflare sign-in open the browser.
    func start(mode: ConnectionMode, hostname: String, port: Int, interactive: Bool) {
        self.mode = mode
        self.port = port
        // The host name goes to cloudflared as an argument and into config.yml: only a
        // plain DNS name (no leading "-", no spaces, quotes or newlines) is passed on.
        let host = hostname.trimmingCharacters(in: .whitespaces).lowercased()
        guard mode != .domain || Address.isValidHostname(host) else {
            self.hostname = ""
            send(.refused(mode, "\"\(String(hostname.prefix(80)))\" is not a valid host name"))
            return
        }
        self.hostname = host
        binary = usableBinary()
        let setup = TunnelSetup(hasBinary: binary != nil, hasCert: FileManager.default.fileExists(atPath: cert.path),
                                configured: mode == .domain && configured(for: hostname))
        send(.start(mode, setup, interactive: interactive))
    }

    func signInAgain() {
        try? FileManager.default.removeItem(at: cert)
        send(.signIn)
    }

    func stop() { send(.stop) }

    /// Stops and returns once cloudflared (and any sign-in or setup command) has exited.
    func shutdown() async {
        send(.stop)
        await stopping?.value
    }
    private var stopping: Task<Void, Never>?

    private func send(_ event: TunnelEvent) {
        let actions = machine.handle(event)
        onPhase?(machine.phase)
        for a in actions { perform(a) }
    }

    private var environment: [String: String] {
        ["HOME": paths.cloudflared.path, "PATH": "/usr/bin:/bin:/usr/sbin:/sbin", "TMPDIR": NSTemporaryDirectory()]
    }

    private func perform(_ action: TunnelAction) {
        switch action {
        case .stopChild:
            generation += 1
            pendingRestart?.cancel()
            let tunnel = child.stop(), command = oneShot?.stop()
            oneShot = nil
            stopping = Task { await tunnel.value; await command?.value }
        case .publishQuickURL(let url):
            onQuickURL?(url)
        case .install:
            Task {
                do {
                    binary = try await installer.install(log: log)
                    send(.installed)
                } catch {
                    log.note("cloudflared install failed: \(error.localizedDescription)")
                    send(.installFailed(error.localizedDescription))
                }
            }
        case .runQuick:
            supervise(["tunnel", "--no-autoupdate", "--url", "http://127.0.0.1:\(port)"])
        case .runTunnel:
            supervise(["tunnel", "--no-autoupdate", "--config", configFile.path, "run"])
        case .login:
            try? SecureFiles.ensureDirectory(dotDir)
            let mine = generation
            Task {
                let r = await command(["tunnel", "login"], watch: true)
                guard mine == generation else { return }
                if FileManager.default.fileExists(atPath: cert.path) { chmod(cert.path, 0o600) }
                let ok = r.status == 0 && FileManager.default.fileExists(atPath: cert.path)
                send(.loginFinished(ok: ok, message: lastLine(r.output)))
            }
        case .create:
            let mine = generation
            Task {
                var r = await command(["tunnel", "--origincert", cert.path, "create", "--credentials-file", credentials.path, "-o", "json", tunnelName])
                var ok = r.status == 0 && CloudflaredOutput.tunnelID(in: r.output) != nil
                // Set up before (another install, or files removed): reuse the tunnel and
                // fetch its credentials again.
                if !ok && CloudflaredOutput.alreadyExists(r.output) {
                    r = await command(["tunnel", "--origincert", cert.path, "token", "--cred-file", credentials.path, tunnelName])
                    ok = r.status == 0 && FileManager.default.fileExists(atPath: credentials.path)
                }
                if ok { chmod(credentials.path, 0o600) }
                guard mine == generation else { return }
                send(.created(ok: ok, message: lastLine(r.output)))
            }
        case .route:
            let mine = generation
            let host = hostname
            guard Address.isValidHostname(host) else { send(.routed(ok: false, message: "invalid host name")); return }
            Task {
                // Never --overwrite-dns: an existing record for this name is the user's to remove.
                let r = await command(["tunnel", "--origincert", cert.path, "route", "dns", tunnelName, host])
                guard mine == generation else { return }
                send(.routed(ok: r.status == 0, message: lastLine(r.output)))
            }
        case .writeConfig:
            do {
                guard let text = try? String(contentsOf: credentials, encoding: .utf8), let id = CloudflaredOutput.tunnelID(in: text) else {
                    throw CloudflaredInstaller.Failure.download("no tunnel id in the credentials file")
                }
                let yaml = CloudflaredConfigFile.yaml(tunnelID: id, credentialsFile: credentials.path, hostname: hostname.lowercased(), port: port)
                try SecureFiles.write(Data(yaml.utf8), to: configFile)
                send(.configWritten(ok: true, message: ""))
            } catch {
                send(.configWritten(ok: false, message: error.localizedDescription))
            }
        case .restartAfter(let delay):
            let item = DispatchWorkItem { [weak self] in MainActor.assumeIsolated { self?.send(.restartDue) } }
            pendingRestart = item
            DispatchQueue.main.asyncAfter(deadline: .now() + delay, execute: item)
        }
    }

    /// The binary still in place, or Castpane's copy found or made again; checked before
    /// each start, so one removed since is not tried again and again.
    private func usableBinary() -> URL? {
        if let binary, FileManager.default.isExecutableFile(atPath: binary.path) { return binary }
        return installer.existing(log: log)
    }

    private func supervise(_ args: [String]) {
        binary = usableBinary()
        guard let binary else {
            log.note("cloudflared is missing")
            send(.exited(ranFor: 0))
            return
        }
        generation += 1
        let mine = generation
        do {
            try child.launch(binary, args, environment: environment, directory: paths.cloudflared, log: log,
                             onLine: { [weak self] line in self?.line(line, generation: mine) },
                             onExit: { [weak self] _, ran in
                                 guard let self, mine == self.generation else { return }
                                 self.send(.exited(ranFor: ran))
                             })
        } catch {
            log.note("could not start cloudflared: \(error.localizedDescription)")
            send(.exited(ranFor: 0))
        }
    }

    private func line(_ line: String, generation mine: Int) {
        onLine?(line)
        guard mine == generation else { return }
        send(.output(line))
    }

    private func command(_ args: [String], watch: Bool = false) async -> (status: Int32, output: String) {
        guard let binary else { return (-1, "cloudflared is missing") }
        return await runToEnd(binary, args, environment: environment, log: log, records: records, onLine: { [weak self] line in
            self?.onLine?(line)
            if watch { self?.send(.output(line)) }
        }, register: { [weak self] c in self?.oneShot = c })
    }

    private func lastLine(_ output: String) -> String {
        let lines = output.split(whereSeparator: \.isNewline).map { String($0) }
        let errors = lines.filter { $0.contains("ERR") || $0.lowercased().contains("error") }
        return String((errors.last ?? lines.last ?? "").suffix(200))
    }
}
