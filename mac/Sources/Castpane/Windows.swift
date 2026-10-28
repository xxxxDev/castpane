import SwiftUI
import AppKit
import CastpaneCore
import CastpaneHost

/// The first-run assistant. First what this Mac is for: the one people connect to
/// (account, permissions, connection, done), or one that shows in another Mac's Castpane
/// (permissions, join, done), which needs no account or address (the owner's request,
/// 2026-10-29).
struct Wizard: View {
    static let doneKey = "wizardDone"
    @EnvironmentObject var model: AppModel
    @ViewState private var step: Int
    @ViewState private var role: Role
    @ViewState private var joined = false

    enum Role { case main, member }
    enum Step { case role, account, permissions, connection, join, done, joinedDone }

    private var steps: [Step] { role == .main ? [.role, .account, .permissions, .connection, .done] : [.role, .permissions, .join, .joinedDone] }
    private var current: Step { steps[min(step, steps.count - 1)] }

    private func title(_ s: Step) -> String {
        switch s {
        case .role: return "Set up this Mac"
        case .account: return "Create the admin account"
        case .permissions: return "Permissions"
        case .connection: return "Connection"
        case .join: return "Join another Mac"
        case .done, .joinedDone: return "Done"
        }
    }
    private func subtitle(_ s: Step) -> String {
        switch s {
        case .role: return "Is this the Mac your phone connects to, or one to show in another Mac's Castpane?"
        case .account: return "This account signs in from your phone. More users can be added later in the web app."
        case .permissions: return "Castpane needs two macOS permissions. The status updates by itself."
        case .connection: return "Choose how your phone reaches this Mac."
        case .join: return "On the other Mac's web app, open Remote and tap Add another Mac; enter its address and code here."
        case .done: return "Scan the code with your phone's camera, sign in, and you will see this Mac."
        case .joinedDone: return "This Mac now shows on the other Mac's Remote page."
        }
    }

    init(step: Int = 0, role: Role = .main) { _step = ViewState(initialValue: step); _role = ViewState(initialValue: role) }

    var body: some View {
        VStack(alignment: .leading, spacing: 18) {
            HStack(alignment: .center) {
                Label { Text("Set up Castpane") } icon: { AppMark(size: 22) }
                    .font(.headline).foregroundStyle(.secondary)
                Spacer()
                StepDots(count: steps.count, current: step)
            }
            VStack(alignment: .leading, spacing: 4) {
                Text(title(current)).font(.largeTitle.bold())
                Text(subtitle(current)).foregroundStyle(.secondary).fixedSize(horizontal: false, vertical: true)
            }
            Group {
                switch current {
                case .role: RoleStep(role: $role)
                case .account: AccountStep(next: { step += 1 })
                case .permissions: PermissionsPane(showNote: false)
                case .connection: ConnectionPane(showLog: false)
                case .join: OtherMacsTab(onStatus: { joined = $0.state != "off" }, showIntro: false).padding(.horizontal, -20)
                case .done: DoneStep()
                case .joinedDone: JoinedStep()
                }
            }
            .frame(maxWidth: .infinity, maxHeight: .infinity, alignment: .topLeading)
            HStack {
                if step > 0 { Button("Back") { step -= 1 }.secondaryButtonStyle().controlSize(.large) }
                Spacer()
                Group {
                    if current == .account {
                        if (model.status?.users ?? 0) > 0 { Button("Next") { step += 1 } }
                    } else if current == .join {
                        if joined { Button("Next") { step += 1 } }
                    } else if step < steps.count - 1 {
                        Button("Next") { step += 1 }
                    } else {
                        Button("Finish") {
                            UserDefaults.standard.set(true, forKey: Self.doneKey)
                            Windows.shared.close("wizard")
                        }
                    }
                }
                .primaryButtonStyle().controlSize(.large).keyboardShortcut(.defaultAction)
            }
        }
        .padding(.horizontal, 28)
        .padding(.top, 36)
        .padding(.bottom, 24)
        .frame(width: Wizard.size.width, height: Wizard.size.height)
        .background(WindowBackdrop())
    }

    static let size = NSSize(width: 780, height: 540)
}

/// Where the assistant is: one dot a step, the current one drawn long.
private struct StepDots: View {
    let count: Int
    let current: Int
    var body: some View {
        HStack(spacing: 6) {
            ForEach(0..<count, id: \.self) { i in
                Capsule()
                    .fill(i <= current ? Palette.blue : Palette.muted.opacity(0.35))
                    .frame(width: i == current ? 22 : 8, height: 8)
            }
        }
        .animation(.snappy, value: current)
        .accessibilityElement()
        .accessibilityLabel("Step \(current + 1) of \(count)")
    }
}

/// What this Mac is for: two cards to pick from.
private struct RoleStep: View {
    @Binding var role: Wizard.Role

    var body: some View {
        HStack(alignment: .top, spacing: 16) {
            card(.main, "iphone.and.arrow.forward", "The Mac I connect to",
                 "Your phone signs in to this Mac. It gets an account and an address, and other Macs can join it.")
            card(.member, "macbook.and.iphone", "Show it in another Mac's Castpane",
                 "This Mac joins one that is already set up, with a code from it. No account or address here.")
        }
    }

    private func card(_ r: Wizard.Role, _ symbol: String, _ title: String, _ text: String) -> some View {
        Button { role = r } label: {
            VStack(alignment: .leading, spacing: 10) {
                HStack {
                    Image(systemName: symbol).font(.title2).foregroundStyle(Palette.blue)
                    Spacer()
                    Image(systemName: role == r ? "checkmark.circle.fill" : "circle").font(.title3)
                        .foregroundStyle(role == r ? Palette.blue : Palette.muted)
                }
                Text(title).font(.headline)
                Text(text).font(.callout).foregroundStyle(.secondary).fixedSize(horizontal: false, vertical: true)
                Spacer(minLength: 0)
            }
            .frame(maxWidth: .infinity, minHeight: 150, alignment: .topLeading)
            .contentShape(Rectangle())
        }
        .buttonStyle(.plain)
        .glassCard()
        .overlay(RoundedRectangle(cornerRadius: 18, style: .continuous).stroke(role == r ? Palette.blue : .clear, lineWidth: 2))
        .fixedSize(horizontal: false, vertical: true)
    }
}

private struct JoinedStep: View {
    var body: some View {
        VStack(alignment: .leading, spacing: 14) {
            Label("Open the other Mac's web app, then Remote: this Mac is listed there.", systemImage: "rectangle.on.rectangle")
            Label("Castpane stays in the menu bar. Settings › Other Macs shows the link, or leaves.", systemImage: "menubar.rectangle")
            Label("Every session is logged here too, and you can pause sharing from the menu bar.", systemImage: "eye")
        }
        .font(.callout)
        .fixedSize(horizontal: false, vertical: true)
        .frame(maxWidth: .infinity, alignment: .leading)
        .glassCard()
    }
}

private struct AccountStep: View {
    @EnvironmentObject var model: AppModel
    let next: () -> Void
    @ViewState private var username = "admin"
    @ViewState private var password = ""
    @ViewState private var confirm = ""
    @ViewState private var busy = false
    @ViewState private var message: String?

    var body: some View {
        if let s = model.status, s.users > 0 {
            Label("An admin account exists (\(s.admins) admin\(s.admins == 1 ? "" : "s"), \(s.users) user\(s.users == 1 ? "" : "s")).",
                  systemImage: "checkmark.circle.fill").foregroundStyle(.green).font(.title3)
                .frame(maxWidth: .infinity, alignment: .leading)
                .glassCard()
        } else {
            VStack(alignment: .leading, spacing: 12) {
                Form {
                    TextField("User name", text: $username)
                    SecureField("Password", text: $password)
                    SecureField("Password again", text: $confirm)
                }
                .glassCard()
                if model.status == nil {
                    Text("Waiting for the castpane server (\(model.serverState.summary))…").font(.callout).foregroundStyle(.secondary)
                }
                if let message { Text(message).foregroundStyle(.red).font(.callout) }
                HStack {
                    Spacer()
                    Button(busy ? "Creating…" : "Create Account") { create() }
                        .primaryButtonStyle()
                        .disabled(busy || model.status == nil || username.trimmingCharacters(in: .whitespaces).isEmpty
                                  || password.count < 8 || password != confirm)
                        .keyboardShortcut(.defaultAction)
                }
                if !password.isEmpty && password.count < 8 { Text("At least 8 characters.").font(.caption).foregroundStyle(.secondary) }
                if !confirm.isEmpty && password != confirm { Text("The passwords differ.").font(.caption).foregroundStyle(.secondary) }
            }
        }
    }

    private func create() {
        busy = true
        message = nil
        let api = model.api
        let name = username.trimmingCharacters(in: .whitespaces)
        let pw = password
        Task {
            do {
                _ = try await api.setup(username: name, password: pw)
                password = ""
                confirm = ""
                model.refreshStatus()
                next()
            } catch {
                message = error.localizedDescription
            }
            busy = false
        }
    }
}

private struct DoneStep: View {
    @EnvironmentObject var model: AppModel
    var body: some View {
        HStack(alignment: .top, spacing: 20) {
            AddressCard(showQR: true, qrSize: 170).frame(width: 240).glassCard()
            VStack(alignment: .leading, spacing: 14) {
                Label("In Safari on iPhone, tap Share › Add to Home Screen to keep Castpane as an app.", systemImage: "iphone")
                Label("Castpane stays in the menu bar. Settings are there too.", systemImage: "menubar.rectangle")
                Label("Every connection is logged, and you can pause sharing from the menu bar.", systemImage: "eye")
            }
            .font(.callout)
            .fixedSize(horizontal: false, vertical: true)
            .frame(maxWidth: .infinity, alignment: .leading)
            .glassCard()
        }
    }
}

struct SettingsView: View {
    @EnvironmentObject var model: AppModel
    @ViewState private var page: Page

    enum Page: String, CaseIterable, Identifiable {
        case general = "General", permissions = "Permissions", connection = "Connection"
        case others = "Other Macs", accounts = "Accounts", activity = "Activity", about = "About"
        var id: Self { self }
        var symbol: String {
            switch self {
            case .general: return "gearshape"
            case .permissions: return "lock.shield"
            case .connection: return "network"
            case .others: return "macbook.and.iphone"
            case .accounts: return "person.2"
            case .activity: return "clock"
            case .about: return "info.circle"
            }
        }
    }

    private var loadsActivity = true

    init(page: Page = .general, loadsActivity: Bool = true) {
        _page = ViewState(initialValue: page)
        self.loadsActivity = loadsActivity
    }

    /// Wide enough for the Connection page: sidebar, the connection choices and the QR card.
    static let size = NSSize(width: 980, height: 580)

    var body: some View {
        // A sidebar of pages, as in System Settings, on a glass panel.
        HStack(spacing: 0) {
            VStack(alignment: .leading, spacing: 2) {
                ForEach(Page.allCases) { p in
                    Button { page = p } label: {
                        Label(p.rawValue, systemImage: p.symbol)
                            .frame(maxWidth: .infinity, alignment: .leading)
                            .padding(.horizontal, 10).padding(.vertical, 6)
                            .background(p == page ? Palette.blue : .clear,
                                        in: RoundedRectangle(cornerRadius: 8, style: .continuous))
                            .foregroundStyle(p == page ? Color.white : Palette.ink)
                            .contentShape(Rectangle())
                    }
                    .buttonStyle(.plain)
                }
                Spacer()
            }
            .frame(width: 170)
            .padding(.top, 28)
            .glassCard(cornerRadius: 16, padding: 8)
            .padding(10)

            VStack(alignment: .leading, spacing: 0) {
                Text(page.rawValue).font(.title2.bold()).padding(.horizontal, 20).padding(.top, 16)
                detail
            }
            .frame(maxWidth: .infinity, maxHeight: .infinity, alignment: .topLeading)
        }
        .background(WindowBackdrop())
        .frame(minWidth: SettingsView.size.width, minHeight: SettingsView.size.height)
    }

    @ViewBuilder private var detail: some View {
        switch page {
        case .general: GeneralTab()
        case .permissions: PermissionsPane().padding(20)
        case .connection: ConnectionPane().padding(20)
        case .others: OtherMacsTab()
        case .accounts: AccountsTab()
        case .activity: ActivityTab(loads: loadsActivity)
        case .about: AboutTab()
        }
    }
}

struct GeneralTab: View {
    @EnvironmentObject var model: AppModel
    @ViewState private var clipboardCheck = 0
    private let qualities = [("auto", "Automatic"), ("high", "High"), ("balanced", "Balanced"), ("low", "Low (slow networks)")]

    var body: some View {
        Form {
            Toggle("Launch at login", isOn: Binding(get: { model.launchAtLogin }, set: { model.setLaunchAtLogin($0) }))
            if let m = model.loginItemMessage {
                HStack {
                    Text(m).font(.caption).foregroundStyle(.secondary)
                    if LoginItem.needsApproval { Button("Open Login Items") { LoginItem.openSettings() } }
                }
            }
            Toggle("Keep this Mac awake while it is on power", isOn: Binding(get: { model.config.keepAwake }, set: { model.setKeepAwake($0) }))
            Picker("Default quality", selection: Binding(get: { model.config.defaultQuality }, set: { model.setQuality($0) })) {
                ForEach(qualities, id: \.0) { Text($0.1).tag($0.0) }
            }
            Toggle("Check for updates automatically", isOn: Binding(get: { model.config.checkForUpdates }, set: { model.setCheckForUpdates($0) }))
            Toggle("Include beta versions", isOn: Binding(get: { model.config.betaUpdates }, set: { model.setBetaUpdates($0) }))
            LabeledContent("Version") {
                HStack {
                    Text(Updater.currentVersion)
                    Button("Check Now") { model.checkForUpdates() }
                }
            }
            ClipboardAccessRow()
                // Back from System Settings: shown as it is now.
                .id(clipboardCheck)
                .onReceive(NotificationCenter.default.publisher(for: NSApplication.didBecomeActiveNotification)) { _ in clipboardCheck += 1 }
            LabeledContent("Server", value: model.serverState.summary)
            LabeledContent("Port", value: String(model.config.port))
            if let e = model.hostError { Text(e).foregroundStyle(.red) }
            if let e = model.startupError { Text(e).foregroundStyle(.red) }
        }
        .formStyle(.grouped)
        .scrollContentBackground(.hidden)
    }
}

/// Whether a viewer may read this Mac's clipboard without someone here answering macOS's
/// question first (macOS 15.4 and later).
private struct ClipboardAccessRow: View {
    @ViewState private var access = Clipboard.access

    var body: some View {
        if let access {
            LabeledContent("Clipboard from afar") {
                HStack {
                    Text(access == .allowed ? "Allowed" : access == .denied ? "Not allowed" : "Asks on this Mac first")
                        .foregroundStyle(.secondary)
                    if access != .allowed {
                        Button("Allow…") {
                            if access == .notAsked { Clipboard.askOnce() }
                            NSWorkspace.shared.open(URL(string: "x-apple.systempreferences:com.apple.preference.security?Privacy_Pasteboard")!)
                        }
                    }
                }
            }
            if access != .allowed {
                Text("To copy this Mac's clipboard from a phone, set Castpane to Allow in System Settings › Privacy & Security › Paste from Other Apps. Until then it is never read.")
                    .font(.caption).foregroundStyle(.secondary)
            }
        }
    }
}

/// Joining another Mac's Castpane, so this screen shows in that Mac's web app too
/// (docs/multi-mac.md).
struct OtherMacsTab: View {
    @EnvironmentObject var model: AppModel
    /// Told of each status, for the setup assistant's Next.
    var onStatus: (MemberStatus) -> Void = { _ in }
    /// The paragraph on what joining does: the setup assistant says it in its own words.
    var showIntro = true
    @ViewState private var status = MemberStatus()
    @ViewState private var hub = ""
    @ViewState private var code = ""
    @ViewState private var busy = false
    @ViewState private var message: String?
    @ViewState private var confirmLeave = false

    var body: some View {
        Form {
            if showIntro { Section {
                Text("Show this Mac in another Mac's Castpane: its admins can then see and use this screen from that Mac's web app, as they do that Mac's own. This Mac needs no address or account for it.")
                    .foregroundStyle(.secondary)
            } }
            if status.state == "off" {
                Section("Join another Mac") {
                    TextField("Its address", text: $hub, prompt: Text("https://castpane.example.com"))
                    TextField("Code", text: $code, prompt: Text("From Add another Mac on its Remote page"))
                    HStack {
                        if let message { Text(message).foregroundStyle(.red).font(.callout) }
                        Spacer()
                        if busy { ProgressView().controlSize(.small) }
                        Button(busy ? "Joining…" : "Join") { join() }
                            .primaryButtonStyle()
                            .disabled(busy || hub.trimmingCharacters(in: .whitespaces).isEmpty || code.trimmingCharacters(in: .whitespaces).count < 6)
                    }
                }
            } else {
                Section("Joined") {
                    LabeledContent("Mac", value: status.hub)
                    LabeledContent("Link", value: stateText)
                    if status.state == "removed" {
                        Text("That Mac removed this one. Leave, then join again with a new code to show it there again.")
                            .font(.callout).foregroundStyle(.secondary)
                    }
                    HStack {
                        Spacer()
                        Button("Leave…") { confirmLeave = true }.secondaryButtonStyle()
                    }
                }
            }
        }
        .formStyle(.grouped)
        .scrollContentBackground(.hidden)
        .task { await refresh(); while !Task.isCancelled { try? await Task.sleep(nanoseconds: 3_000_000_000); await refresh() } }
        .confirmationDialog("Leave \(status.hub)?", isPresented: $confirmLeave) {
            Button("Leave", role: .destructive) { leave() }
        } message: {
            Text("This Mac stops showing in that Mac's Castpane.")
        }
    }

    private var stateText: String {
        switch status.state {
        case "connected": return "Connected"
        case "connecting": return "Connecting…"
        case "removed": return "Removed by that Mac"
        default: return status.state
        }
    }

    private func refresh() async {
        if let s = try? await model.api.member() { status = s; onStatus(s) }
    }

    private func join() {
        busy = true; message = nil
        let hub = hub.trimmingCharacters(in: .whitespaces), code = code.trimmingCharacters(in: .whitespaces)
        Task {
            do { try await model.api.joinMember(hub: hub.contains("://") ? hub : "https://" + hub, code: code); self.code = "" }
            catch { message = error.localizedDescription }
            busy = false
            await refresh()
        }
    }

    private func leave() {
        Task { try? await model.api.leaveMember(); await refresh() }
    }
}

struct AccountsTab: View {
    @EnvironmentObject var model: AppModel
    var body: some View {
        Form {
            if let s = model.status {
                LabeledContent("Users", value: String(s.users))
                LabeledContent("Admins", value: String(s.admins))
                LabeledContent("Signed-in sessions", value: String(s.sessions))
            } else {
                Text("The castpane server is not answering (\(model.serverState.summary)).").foregroundStyle(.secondary)
            }
            Button("Open Account Management") { model.openAccountManagement() }
            Text("Users, passwords, passkeys and devices are managed in the web app's admin pages.")
                .font(.caption).foregroundStyle(.secondary)
        }
        .formStyle(.grouped)
        .scrollContentBackground(.hidden)
    }
}

struct ActivityTab: View {
    @EnvironmentObject var model: AppModel
    /// As many as fit without scrolling; the logs keep the rest.
    private let shown = 8
    /// Off for snapshots, which show sample entries without a server.
    var loads = true

    var body: some View {
        VStack(alignment: .leading, spacing: 12) {
            HStack {
                Text("Recent remote sessions and sign-ins").foregroundStyle(.secondary)
                Spacer()
                Button("Refresh", systemImage: "arrow.clockwise") { model.refreshActivity() }.secondaryButtonStyle()
            }
            if model.activity.isEmpty {
                VStack(spacing: 8) {
                    Image(systemName: "clock").font(.system(size: 32)).foregroundStyle(.tertiary)
                    Text("Nothing yet.").foregroundStyle(.secondary)
                }
                .frame(maxWidth: .infinity, minHeight: 160)
                .glassCard()
            } else {
                VStack(spacing: 0) {
                    ForEach(Array(model.activity.prefix(shown).enumerated()), id: \.element.id) { i, item in
                        if i > 0 { Divider().padding(.leading, 44) }
                        ActivityRow(item: item)
                    }
                }
                .glassCard(padding: 6)
                if model.activity.count > shown {
                    Button("Older entries are in the logs") { model.openLogs() }.buttonStyle(.link).font(.callout)
                }
            }
        }
        .padding(20)
        .onAppear { if loads { model.refreshActivity() } }
    }
}

/// One entry, in words: who did what, how, and when.
private struct ActivityRow: View {
    let item: ActivityItem

    private var whose: String { item.machine.isEmpty ? "this Mac's" : "\(item.machine)'s" }
        private var times: String { item.count > 1 ? " (\(item.count) times)" : "" }

    private var look: (symbol: String, color: Color, text: String) {
        let who = item.username.isEmpty ? "Someone" : item.username
        switch item.kind {
        case "sign-in": return ("key.fill", Palette.blue, "\(who) signed in")
        case "remote-open": return ("eye.fill", .green, "\(who) started viewing \(item.machine.isEmpty ? "this Mac" : item.machine)")
        case "remote-end": return ("eye.slash.fill", .gray, "\(who) stopped viewing\(item.machine.isEmpty ? "" : " " + item.machine)")
        case "clipboard-read": return ("doc.on.clipboard.fill", .orange, "\(who) copied \(whose) clipboard\(times)")
        case "clipboard-write": return ("doc.on.clipboard", Palette.blue, "\(who) put text on \(whose) clipboard\(times)")
        default: return ("circle.fill", .gray, "\(who): \(item.kind)")
        }
    }

    var body: some View {
        HStack(spacing: 12) {
            Image(systemName: look.symbol)
                .font(.system(size: 13, weight: .semibold)).foregroundStyle(.white)
                .frame(width: 28, height: 28).background(look.color, in: Circle())
            VStack(alignment: .leading, spacing: 2) {
                Text(look.text)
                if !item.detail.isEmpty { Text(item.detail).font(.caption).foregroundStyle(.secondary).lineLimit(1) }
            }
            Spacer()
            if let at = item.at {
                // English, as the rest of the app, whatever the Mac's region.
                Text(at, format: .relative(presentation: .named))
                    .environment(\.locale, Locale(identifier: "en"))
                    .font(.callout).foregroundStyle(.secondary)
                    .help(at.formatted(date: .abbreviated, time: .standard))
            }
        }
        .padding(.horizontal, 10).padding(.vertical, 7)
    }
}

struct AboutTab: View {
    @EnvironmentObject var model: AppModel
    var body: some View {
        VStack(spacing: 12) {
            AppMark(size: 96)
            Text("Castpane").font(.title.bold())
            Text("Version \(MacInfo.version)").foregroundStyle(.secondary)
            Text("See and control this Mac from your phone or another computer, in a browser.")
                .multilineTextAlignment(.center)
            Text("Open source under the MIT License.").font(.callout)
            HStack {
                Button("Show Data Folder") { NSWorkspace.shared.open(model.paths.home) }
                Button("Show Logs") { model.openLogs() }
            }
        }
        .frame(maxWidth: .infinity, maxHeight: .infinity)
        .padding(24)
    }
}
