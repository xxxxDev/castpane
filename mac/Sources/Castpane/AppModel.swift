import AppKit
import SwiftUI
import CastpaneCore
import CastpaneHost

/// Everything the menu, the wizard and the settings show, and what they can do.
@MainActor
final class AppModel: ObservableObject {
    let paths = Paths.standard()

    @Published private(set) var config = AppConfig()
    @Published private(set) var status: LocalStatus?
    @Published private(set) var serverState: ServerSupervisor.State = .stopped
    @Published private(set) var tunnelPhase: TunnelPhase = .off
    @Published private(set) var tunnelLog: [String] = []
    @Published private(set) var viewerConnected = false
    @Published private(set) var hostError: String?
    @Published private(set) var startupError: String?
    @Published private(set) var activity: [ActivityItem] = []
    @Published private(set) var screenGranted = Permissions.screen
    @Published private(set) var accessibilityGranted = Permissions.accessibility
    /// Screen Recording was off when the app started and has been asked for since: a
    /// restart is what makes a new grant take effect.
    @Published private(set) var screenNeedsRestart = false
    @Published var launchAtLogin = LoginItem.isOn
    @Published private(set) var loginItemMessage: String?

    private let screenAtLaunch = Permissions.screen
    private var localToken = ""
    private var host: HostServer?
    private lazy var server = ServerSupervisor(paths: paths)
    private lazy var tunnel = TunnelManager(paths: paths)
    private let keepAwake = KeepAwake()
    private(set) lazy var updater = Updater(paths: paths)
    private var poll: Timer?
    private var permissionPoll: Timer?
    private var booted = false
    private var wizardOffered = false

    var address: String { config.address }
    var paused: Bool { config.paused }
    var api: LocalAPI { LocalAPI(port: config.port, token: localToken) }
    /// The page the Mac itself opens (the server listens on 127.0.0.1).
    var localURL: URL { URL(string: "http://127.0.0.1:\(config.port)")! }

    #if DEBUG
    /// For snapshots only: sample entries and a made-up quick tunnel address, so no picture
    /// shows this Mac's own.
    func showSample(activity items: [ActivityItem], quickURL: String) {
        activity = items
        config.connection = .quick
        config.applyAddress(quickURL: quickURL)
        tunnelPhase = .running(quickURL: quickURL)
    }
    #endif

    // MARK: start and quit

    func boot() {
        guard !booted else { return }
        booted = true
        do {
            try paths.prepare()
            // Fresh tokens each launch: the server is our child and reads them at start.
            let hostToken = SecureFiles.newToken()
            localToken = SecureFiles.newToken()
            try SecureFiles.write(Data(hostToken.utf8), to: paths.hostToken)
            try SecureFiles.write(Data(localToken.utf8), to: paths.localToken)
            config = AppConfig.load(from: paths.config)
            config.applyAddress(quickURL: nil)
            try config.save(to: paths.config)

            HostServer.version = MacInfo.version
            let h = HostServer(socketPath: paths.hostSocket.path, token: hostToken)
            h.onViewerChange = { [weak self] on in
                self?.viewerConnected = on
                self?.keepAwake.viewer = on
            }
            host = h
            if !config.paused { startHost() }
        } catch {
            startupError = "Castpane could not prepare its folder: \(error)"
            return
        }

        server.onState = { [weak self] s in MainActor.assumeIsolated { self?.serverState = s } }

        tunnel.onPhase = { [weak self] p in MainActor.assumeIsolated { self?.tunnelPhase = p } }
        tunnel.onQuickURL = { [weak self] url in MainActor.assumeIsolated { self?.quickURLChanged(url) } }
        tunnel.onLine = { [weak self] line in
            MainActor.assumeIsolated {
                guard let self else { return }
                self.tunnelLog.append(line)
                if self.tunnelLog.count > 300 { self.tunnelLog.removeFirst(self.tunnelLog.count - 300) }
            }
        }
        // Children a crashed Castpane left behind go first: an old server would still hold
        // the port, an old cloudflared still serve the address.
        let records = ChildRecords(folder: paths.children)
        let ours = records.all().isEmpty ? nil : ownExecutables()
        let log = LogFile(paths.serverLog)
        Task {
            if let ours { await StaleChildren.end(records: records, isOurs: ours, note: { log.note($0) }) }
            guard !self.shuttingDown else { return }
            self.server.run(port: self.config.port, publicOrigin: self.config.publicOrigin)
            self.tunnel.start(mode: self.config.connection, hostname: self.config.domainHostname, port: self.config.port, interactive: false)
        }

        keepAwake.enabled = config.keepAwake
        keepAwake.sharing = !config.paused

        poll = Timer.scheduledTimer(withTimeInterval: 3, repeats: true) { [weak self] _ in
            MainActor.assumeIsolated { self?.refreshStatus() }
        }
        permissionPoll = Timer.scheduledTimer(withTimeInterval: 1, repeats: true) { [weak self] _ in
            MainActor.assumeIsolated { self?.refreshPermissions() }
        }
        refreshStatus()

        updater.onOffer = { [weak self] _ in
            guard let self else { return }
            Windows.shared.showUpdate(self)
        }
        updater.schedule(enabled: { [weak self] in self?.config.checkForUpdates ?? false },
                         includeBeta: { [weak self] in self?.config.betaUpdates ?? false })
    }

    private var shuttingDown = false

    /// Stops everything; returns once the server and cloudflared have exited (SIGKILL
    /// after a few seconds if they do not), without blocking the main thread.
    func shutdown() async {
        shuttingDown = true
        poll?.invalidate()
        permissionPoll?.invalidate()
        host?.stop()
        keepAwake.release()
        let server = self.server.stop()
        await tunnel.shutdown()
        await server.value
    }

    /// The executables a pid file may name for a left-behind child to be ended: inside
    /// this app (its Node), inside Castpane's cloudflared folder (the download or the copy),
    /// or exactly the Node or the Cloudflare-signed cloudflared on PATH (one an earlier
    /// version ran from where it was installed).
    private func ownExecutables() -> @Sendable (String) -> Bool {
        let exact = Set([ServerResources.find()?.node, CloudflaredInstaller(paths: paths).onPath()]
            .compactMap { $0?.resolvingSymlinksInPath().path })
        let bundle = MacInfo.inBundle ? Bundle.main.bundleURL : nil
        let cloudflared = paths.cloudflared
        return { path in
            exact.contains(path) || ChildRecords.path(path, isInside: cloudflared)
                || bundle.map { ChildRecords.path(path, isInside: $0) } == true
        }
    }

    // MARK: status

    func refreshStatus() {
        let api = self.api
        Task {
            let s = try? await api.status()
            self.status = s
            // No account yet: the setup assistant, once per launch.
            if let s, s.users == 0, !self.wizardOffered {
                self.wizardOffered = true
                Windows.shared.showWizard(self)
            }
        }
    }

    func refreshActivity() {
        let api = self.api
        Task { self.activity = (try? await api.activity(limit: 50)) ?? [] }
    }

    func refreshPermissions() {
        screenGranted = Permissions.screen
        accessibilityGranted = Permissions.accessibility
        launchAtLogin = LoginItem.isOn
        if screenGranted && !screenAtLaunch { screenNeedsRestart = true }
    }

    func requestScreen() {
        Permissions.requestScreen()
        Permissions.openScreenSettings()
        if !screenAtLaunch { screenNeedsRestart = true }
    }

    func requestAccessibility() {
        Permissions.requestAccessibility()
        Permissions.openAccessibilitySettings()
    }

    // MARK: sharing

    private func startHost() {
        do {
            try host?.start()
            hostError = nil
        } catch {
            hostError = "Screen sharing could not start: \(error.localizedDescription)"
        }
    }

    func setPaused(_ paused: Bool) {
        guard paused != config.paused else { return }
        config.paused = paused
        save()
        keepAwake.sharing = !paused
        if paused {
            // The server ends the viewer's pass and sign-in before the capture core stops
            // (CastpaneCore/ViewerEnd.swift).
            let api = self.api
            Task {
                await ViewerEnd.endThenStop(end: { try? await api.endViewer() }) {
                    // Sharing turned back on meanwhile: the core stays.
                    if self.config.paused { self.host?.stop() }
                }
            }
        } else {
            startHost()
        }
    }

    /// The menu's "Stop sharing now": the server drops the viewer, ends their pass and
    /// signs out their sign-in, then the core lets them go.
    func endViewer() {
        let api = self.api
        Task {
            await ViewerEnd.endThenStop(end: { try? await api.endViewer() }) { self.host?.disconnect() }
        }
    }

    // MARK: settings

    func setConnection(_ mode: ConnectionMode, domainHostname: String? = nil, tailscaleOrigin: String? = nil) {
        config.connection = mode
        if let domainHostname { config.domainHostname = domainHostname.trimmingCharacters(in: .whitespaces).lowercased() }
        if let tailscaleOrigin { config.tailscaleOrigin = Address.normalizeOrigin(tailscaleOrigin) ?? "" }
        config.applyAddress(quickURL: nil)
        save()
        tunnelLog.removeAll()
        tunnel.start(mode: mode, hostname: config.domainHostname, port: config.port, interactive: true)
        server.run(port: config.port, publicOrigin: config.publicOrigin)
    }

    func signInToCloudflareAgain() { tunnel.signInAgain() }

    private func quickURLChanged(_ url: String?) {
        guard config.connection == .quick else { return }
        config.applyAddress(quickURL: url)
        save()
        server.run(port: config.port, publicOrigin: config.publicOrigin)
    }

    func setKeepAwake(_ on: Bool) {
        config.keepAwake = on
        keepAwake.enabled = on
        save()
    }

    func setCheckForUpdates(_ on: Bool) {
        config.checkForUpdates = on
        save()
    }

    func setBetaUpdates(_ on: Bool) {
        config.betaUpdates = on
        save()
    }

    func checkForUpdates() {
        Windows.shared.showUpdate(self)
        let beta = config.betaUpdates
        Task { await updater.check(includeBeta: beta) }
    }

    func setQuality(_ q: String) {
        config.defaultQuality = q
        save()
    }

    func setLaunchAtLogin(_ on: Bool) {
        do {
            try LoginItem.set(on)
            loginItemMessage = LoginItem.needsApproval ? "Allow Castpane in System Settings › General › Login Items." : nil
        } catch {
            loginItemMessage = MacInfo.inBundle ? error.localizedDescription : "Launch at login works only for Castpane.app, not a development build."
        }
        launchAtLogin = LoginItem.isOn
    }

    private func save() {
        do { try config.save(to: paths.config) } catch { startupError = "Could not save settings: \(error)" }
    }

    // MARK: actions

    func copyAddress() {
        NSPasteboard.general.clearContents()
        NSPasteboard.general.setString(address, forType: .string)
    }

    func openInBrowser() {
        // On this Mac the server is at 127.0.0.1; the public address when there is one.
        let target = address.isEmpty ? localURL.absoluteString : address
        if let url = URL(string: target) { NSWorkspace.shared.open(url) }
    }

    func openAccountManagement() { NSWorkspace.shared.open(localURL.appendingPathComponent("admin/users")) }

    func openLogs() { NSWorkspace.shared.open(paths.logs) }
}
