import SwiftUI
import CastpaneCore

/// The address, with Copy and, when asked, its QR code.
struct AddressCard: View {
    @EnvironmentObject var model: AppModel
    var showQR = true
    var qrSize: CGFloat = 170

    var body: some View {
        VStack(spacing: 12) {
            if model.address.isEmpty {
                Image(systemName: "qrcode").font(.system(size: 48)).foregroundStyle(.tertiary)
                Text(model.config.connection == .quick ? "Waiting for the tunnel's address…"
                     : model.config.connection == .none ? "Choose a connection to get an address." : "No address yet.")
                    .foregroundStyle(.secondary).multilineTextAlignment(.center)
            } else {
                if showQR, let image = QRCode.image(model.address) {
                    Image(nsImage: image).interpolation(.none).resizable().frame(width: qrSize, height: qrSize)
                        .padding(8).background(.white, in: RoundedRectangle(cornerRadius: 10, style: .continuous))
                        .accessibilityLabel("QR code for \(model.address)")
                }
                Text(model.address).font(.system(.callout, design: .monospaced)).textSelection(.enabled)
                    .lineLimit(2).truncationMode(.middle).multilineTextAlignment(.center)
                Button("Copy Address", systemImage: "doc.on.doc") { model.copyAddress() }.secondaryButtonStyle()
                if model.config.connection == .quick {
                    Label("Changes each time the tunnel starts.", systemImage: "exclamationmark.triangle")
                        .font(.caption).foregroundStyle(.orange)
                }
            }
        }
        .frame(maxWidth: .infinity)
    }
}

struct PermissionRow: View {
    let title: String
    let detail: String
    let granted: Bool
    let open: () -> Void

    var body: some View {
        HStack(alignment: .top, spacing: 12) {
            Image(systemName: granted ? "checkmark.circle.fill" : "xmark.circle")
                .foregroundStyle(granted ? .green : .orange).font(.title2)
            VStack(alignment: .leading, spacing: 4) {
                Text(title).font(.headline)
                Text(detail).font(.callout).foregroundStyle(.secondary).fixedSize(horizontal: false, vertical: true)
            }
            Spacer()
            if !granted {
                Button("Open System Settings", action: open).secondaryButtonStyle().controlSize(.large)
            } else {
                Text("Allowed").foregroundStyle(.secondary)
            }
        }
        .glassCard()
    }
}

struct PermissionsPane: View {
    @EnvironmentObject var model: AppModel
    var showNote = true

    var body: some View {
        VStack(alignment: .leading, spacing: 12) {
            PermissionRow(title: "Screen Recording", detail: "To show this Mac's screen or one window to your viewer.",
                          granted: model.screenGranted) { model.requestScreen() }
            PermissionRow(title: "Accessibility", detail: "To let your viewer click, scroll and type on this Mac.",
                          granted: model.accessibilityGranted) { model.requestAccessibility() }
            if model.screenNeedsRestart {
                HStack {
                    Text("macOS applies Screen Recording after Castpane starts again.").font(.callout)
                    Spacer()
                    Button("Restart Castpane") { MacInfo.relaunch() }.primaryButtonStyle()
                }
                .glassCard(padding: 12)
            }
            Text(showNote ? "The status updates by itself. A new build of Castpane asks again, because it is signed ad hoc."
                          : "A new build of Castpane asks again, because it is signed ad hoc.")
                .font(.footnote).foregroundStyle(.secondary)
        }
    }
}

struct ConnectionPane: View {
    @EnvironmentObject var model: AppModel
    @ViewState private var mode: ConnectionMode = .quick
    @ViewState private var domain = ""
    @ViewState private var tailscale = ""
    @ViewState private var loaded = false
    @ViewState private var showingLog = false
    var showLog = true
    /// The mode shown first, when not the one in use (for snapshots).
    var initialMode: ConnectionMode?

    private var changed: Bool {
        mode != model.config.connection
            || (mode == .domain && domain.lowercased() != model.config.domainHostname)
            || (mode == .tailscale && (Address.normalizeOrigin(tailscale) ?? "") != model.config.tailscaleOrigin)
    }

    private var canApply: Bool {
        switch mode {
        case .domain: return Address.isValidHostname(domain.trimmingCharacters(in: .whitespaces))
        case .tailscale: return Address.normalizeOrigin(tailscale) != nil
        default: return true
        }
    }

    var body: some View {
        HStack(alignment: .top, spacing: 20) {
            VStack(alignment: .leading, spacing: 14) {
                Picker("Connection", selection: $mode) {
                    ForEach(ConnectionMode.choices, id: \.self) { Text(Self.segment($0)).tag($0) }
                }
                .pickerStyle(.segmented)
                .labelsHidden()
                // Its own size, fixed: stretched to the column, AppKit's segmented control
                // went back and forth between two widths each time the window updated.
                .fixedSize()

                explanation

                if model.config.connection.usesCloudflared {
                    HStack {
                        Text("Tunnel:").bold()
                        Text(model.tunnelPhase.summary).foregroundStyle(tunnelColor).textSelection(.enabled).lineLimit(2)
                    }
                    .font(.callout)
                    if case .loggingIn(let url?) = model.tunnelPhase, let link = URL(string: url) {
                        Link("Open the Cloudflare sign-in page", destination: link)
                    }
                }

                Spacer(minLength: 0)

                HStack {
                    if showLog && model.config.connection.usesCloudflared {
                        Button("Tunnel Log…") { showingLog = true }.secondaryButtonStyle()
                    }
                    Spacer()
                    if model.config.connection == .domain && mode == .domain {
                        Button("Sign in Again") { model.signInToCloudflareAgain() }.secondaryButtonStyle()
                    }
                    Button(changed ? "Use This Connection" : "Connect Again") {
                        model.setConnection(mode, domainHostname: domain, tailscaleOrigin: tailscale)
                    }
                    .primaryButtonStyle()
                    .disabled(!canApply)
                }
            }
            .frame(maxWidth: .infinity, alignment: .leading)

            AddressCard(showQR: true, qrSize: 150)
                .frame(width: 210)
                .glassCard()
        }
        .sheet(isPresented: $showingLog) { TunnelLogSheet().environmentObject(model) }
        .onAppear {
            guard !loaded else { return }
            loaded = true
            mode = initialMode ?? model.config.connection
            domain = model.config.domainHostname
            tailscale = model.config.tailscaleOrigin
        }
    }

    /// Short enough that the segments fit beside the QR code.
    private static func segment(_ mode: ConnectionMode) -> String {
        switch mode {
        case .none: return "Off"
        case .quick: return "Quick tunnel"
        case .domain: return "Own domain"
        case .tailscale: return "Tailscale"
        }
    }

    private var tunnelColor: Color {
        switch model.tunnelPhase {
        case .running: return .green
        case .failed: return .red
        default: return .secondary
        }
    }

    @ViewBuilder private var explanation: some View {
        switch mode {
        case .none:
            Text("No connection: Castpane is reachable on this Mac only, at http://127.0.0.1:\(String(model.config.port)). Choose one of the others to open it from your phone. Turning the connection off stops the tunnel.")
                .font(.callout).fixedSize(horizontal: false, vertical: true)
        case .quick:
            Text("A free Cloudflare tunnel with a random https://….trycloudflare.com address, no account needed. The address changes every time the tunnel starts (each launch of Castpane), so you will have to open the new one.")
                .font(.callout).fixedSize(horizontal: false, vertical: true)
        case .domain:
            VStack(alignment: .leading, spacing: 8) {
                Text("A fixed address on a domain in your Cloudflare account. Castpane signs in to Cloudflare once (in your browser), creates a tunnel for this Mac and points the name below at it.")
                    .font(.callout).fixedSize(horizontal: false, vertical: true)
                TextField("Host name", text: $domain, prompt: Text("remote.example.com")).textFieldStyle(.roundedBorder)
                if !domain.isEmpty && !Address.isValidHostname(domain.trimmingCharacters(in: .whitespaces)) {
                    Text("Enter a full host name, such as remote.example.com.").font(.caption).foregroundStyle(.red)
                }
            }
        case .tailscale:
            VStack(alignment: .leading, spacing: 8) {
                Text("Castpane does not manage Tailscale. Install Tailscale on this Mac and on your phone and sign both in to the same tailnet. Then, on this Mac, run:")
                    .font(.callout).fixedSize(horizontal: false, vertical: true)
                Text("tailscale serve --bg \(String(model.config.port))").font(.system(.callout, design: .monospaced)).textSelection(.enabled)
                Text("It prints an https://….ts.net address. Enter it here:").font(.callout)
                TextField("Address", text: $tailscale, prompt: Text("https://mac.tailnet-name.ts.net")).textFieldStyle(.roundedBorder)
            }
        }
    }
}

struct TunnelLogSheet: View {
    @EnvironmentObject var model: AppModel
    @Environment(\.dismiss) private var dismiss

    var body: some View {
        VStack(alignment: .leading, spacing: 12) {
            Text("Tunnel log").font(.headline)
            ScrollView {
                Text(model.tunnelLog.suffix(200).joined(separator: "\n"))
                    .font(.system(.caption, design: .monospaced)).textSelection(.enabled)
                    .frame(maxWidth: .infinity, alignment: .leading)
            }
            HStack {
                Button("Show Log Files") { model.openLogs() }.secondaryButtonStyle()
                Spacer()
                Button("Done") { dismiss() }.primaryButtonStyle().keyboardShortcut(.defaultAction)
            }
        }
        .padding(20)
        .frame(width: 560, height: 380)
    }
}
