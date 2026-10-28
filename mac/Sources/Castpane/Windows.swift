import SwiftUI
import CastpaneCore

/// The first-run assistant: account, permissions, connection, done.
struct Wizard: View {
    static let doneKey = "wizardDone"
    @EnvironmentObject var model: AppModel
    @ViewState private var step: Int
    private let titles = ["Create the admin account", "Permissions", "Connection", "Done"]
    private let subtitles = [
        "This account signs in from your phone. More users can be added later in the web app.",
        "Castpane needs two macOS permissions. The status updates by itself.",
        "Choose how your phone reaches this Mac.",
        "Scan the code with your phone's camera, sign in, and you will see this Mac.",
    ]

    init(step: Int = 0) { _step = ViewState(initialValue: step) }

    var body: some View {
        VStack(alignment: .leading, spacing: 18) {
            HStack(alignment: .center) {
                Label { Text("Set up Castpane") } icon: { AppMark(size: 22) }
                    .font(.headline).foregroundStyle(.secondary)
                Spacer()
                StepDots(count: titles.count, current: step)
            }
            VStack(alignment: .leading, spacing: 4) {
                Text(titles[step]).font(.largeTitle.bold())
                Text(subtitles[step]).foregroundStyle(.secondary).fixedSize(horizontal: false, vertical: true)
            }
            Group {
                switch step {
                case 0: AccountStep(next: { step = 1 })
                case 1: PermissionsPane(showNote: false)
                case 2: ConnectionPane(showLog: false)
                default: DoneStep()
                }
            }
            .frame(maxWidth: .infinity, maxHeight: .infinity, alignment: .topLeading)
            HStack {
                if step > 0 { Button("Back") { step -= 1 }.secondaryButtonStyle().controlSize(.large) }
                Spacer()
                Group {
                    if step == 0 {
                        if (model.status?.users ?? 0) > 0 { Button("Next") { step = 1 } }
                    } else if step < titles.count - 1 {
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
        case accounts = "Accounts", activity = "Activity", about = "About"
        var id: Self { self }
        var symbol: String {
            switch self {
            case .general: return "gearshape"
            case .permissions: return "lock.shield"
            case .connection: return "network"
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
        case .accounts: AccountsTab()
        case .activity: ActivityTab(loads: loadsActivity)
        case .about: AboutTab()
        }
    }
}

struct GeneralTab: View {
    @EnvironmentObject var model: AppModel
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
            LabeledContent("Server", value: model.serverState.summary)
            LabeledContent("Port", value: String(model.config.port))
            if let e = model.hostError { Text(e).foregroundStyle(.red) }
            if let e = model.startupError { Text(e).foregroundStyle(.red) }
        }
        .formStyle(.grouped)
        .scrollContentBackground(.hidden)
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

    private var look: (symbol: String, color: Color, text: String) {
        let who = item.username.isEmpty ? "Someone" : item.username
        switch item.kind {
        case "sign-in": return ("key.fill", Palette.blue, "\(who) signed in")
        case "remote-open": return ("eye.fill", .green, "\(who) started viewing this Mac")
        case "remote-end": return ("eye.slash.fill", .gray, "\(who) stopped viewing")
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
