import AppKit
import SwiftUI
import CastpaneCore

@main
struct CastpaneApp: App {
    @NSApplicationDelegateAdaptor(AppDelegate.self) private var delegate

    var body: some Scene {
        MenuBarExtra {
            MenuContent().environmentObject(delegate.model)
        } label: {
            MenuIcon().environmentObject(delegate.model)
        }
        .menuBarExtraStyle(.menu)
    }
}

final class AppDelegate: NSObject, NSApplicationDelegate {
    @MainActor lazy var model = AppModel()

    func applicationDidFinishLaunching(_ notification: Notification) {
        // A menu-bar app: no Dock icon (Info.plist says so too; this covers `swift run`).
        NSApp.setActivationPolicy(.accessory)
        #if DEBUG
        if let folder = ProcessInfo.processInfo.environment["CASTPANE_SNAPSHOT"] {
            MainActor.assumeIsolated { Snapshot.run(model, to: URL(fileURLWithPath: folder)) }
            return
        }
        #endif
        MainActor.assumeIsolated {
            model.boot()
            if !UserDefaults.standard.bool(forKey: Wizard.doneKey) { Windows.shared.showWizard(model) }
        }
    }

    /// Quitting waits for the server and cloudflared to exit, without blocking the main
    /// thread: the app answers "later" and quits once they are gone.
    func applicationShouldTerminate(_ sender: NSApplication) -> NSApplication.TerminateReply {
        MainActor.assumeIsolated {
            let model = self.model
            Task { @MainActor in
                await model.shutdown()
                NSApp.reply(toApplicationShouldTerminate: true)
            }
        }
        return .terminateLater
    }
}

/// The app's windows, made in AppKit so they open exactly when asked (a menu-bar app has
/// no main window, and SwiftUI scenes would open one at launch).
@MainActor
final class Windows: NSObject, NSWindowDelegate {
    static let shared = Windows()
    private var open: [String: NSWindow] = [:]

    func show<V: View>(_ id: String, title: String, size: NSSize, resizable: Bool = false, bare: Bool = false,
                       @ViewBuilder _ view: () -> V) {
        // While one of its windows is open, Castpane is in the Dock and the app switcher,
        // so the window is easy to find again; with none open, the menu bar alone.
        NSApp.setActivationPolicy(.regular)
        NSApp.activate(ignoringOtherApps: true)
        if let w = open[id] { w.makeKeyAndOrderFront(nil); return }
        var style: NSWindow.StyleMask = [.titled, .closable, .miniaturizable]
        if resizable { style.insert(.resizable) }
        // A bare window draws its own title: the content runs up under the title bar.
        if bare { style.insert(.fullSizeContentView) }
        let w = NSWindow(contentRect: NSRect(origin: .zero, size: size), styleMask: style, backing: .buffered, defer: false)
        w.title = title
        if bare {
            w.titleVisibility = .hidden
            w.titlebarAppearsTransparent = true
            w.isMovableByWindowBackground = true
        }
        w.isReleasedWhenClosed = false
        w.contentView = NSHostingView(rootView: view().tint(Palette.blue))
        w.identifier = NSUserInterfaceItemIdentifier(id)
        w.delegate = self
        w.center()
        open[id] = w
        w.makeKeyAndOrderFront(nil)
    }

    func close(_ id: String) { open[id]?.close() }

    func windowWillClose(_ notification: Notification) {
        guard let w = notification.object as? NSWindow, let id = w.identifier?.rawValue else { return }
        open[id] = nil
        if open.isEmpty { NSApp.setActivationPolicy(.accessory) }
    }

    func showWizard(_ model: AppModel) {
        show("wizard", title: "Set up Castpane", size: Wizard.size, bare: true) { Wizard().environmentObject(model) }
    }

    func showSettings(_ model: AppModel) {
        show("settings", title: "Castpane Settings", size: SettingsView.size, resizable: true, bare: true) {
            SettingsView().environmentObject(model)
        }
    }

    func showQR(_ model: AppModel) {
        show("qr", title: "Open on your phone", size: NSSize(width: 340, height: 400)) {
            AddressCard(showQR: true, qrSize: 220).padding(24).frame(maxWidth: .infinity, maxHeight: .infinity)
                .background(WindowBackdrop()).environmentObject(model)
        }
    }
}

struct MenuIcon: View {
    @EnvironmentObject var model: AppModel
    /// The mark in black; as a template, macOS draws it in the menu bar's own colour.
    private static let mark: NSImage? = {
        guard let image = Bundle.main.image(forResource: "MenuIcon") else { return nil }
        image.isTemplate = true
        return image
    }()
    var body: some View {
        if model.paused {
            Image(systemName: "pause.rectangle")
        } else if model.viewerConnected {
            Image(systemName: "eye.circle.fill")
        } else if let mark = Self.mark {
            Image(nsImage: mark)
        } else {
            Image(systemName: "display")
        }
    }
}

struct MenuContent: View {
    @EnvironmentObject var model: AppModel

    var body: some View {
        if let e = model.startupError { Text(e) }
        Text(model.paused ? "Sharing paused" : "Sharing on")
        if let v = model.status?.viewer {
            Text("Viewer: \(v.username)" + (v.since.map { " since \($0.formatted(date: .omitted, time: .shortened))" } ?? ""))
        } else if model.viewerConnected {
            Text("A viewer is connected")
        } else {
            Text("No viewer connected")
        }
        if model.serverState != .running { Text("Server: \(model.serverState.summary)") }
        Divider()
        if model.address.isEmpty {
            Text(model.config.connection == .quick ? "Waiting for the tunnel address…" : "No address yet: choose a connection in Settings")
        } else {
            Text(model.address)
            Button("Copy Address") { model.copyAddress() }
            Button("Show QR Code…") { Windows.shared.showQR(model) }
        }
        Button("Open in Browser") { model.openInBrowser() }
        Divider()
        Toggle("Pause Sharing", isOn: Binding(get: { model.paused }, set: { model.setPaused($0) }))
        if model.viewerConnected || model.status?.viewer != nil {
            Button("Stop Sharing Now") { model.endViewer() }
        }
        Divider()
        Button("Settings…") { Windows.shared.showSettings(model) }.keyboardShortcut(",")
        Button("Setup Assistant…") { Windows.shared.showWizard(model) }
        Divider()
        Button("Quit Castpane") { NSApp.terminate(nil) }.keyboardShortcut("q")
    }
}

/// SwiftUI's property wrapper under another name. In recent SDKs `@State` resolves to a
/// macro whose plugin ships with Xcode only; through this alias the Command Line Tools
/// build the same property wrapper.
typealias ViewState = SwiftUI.State
