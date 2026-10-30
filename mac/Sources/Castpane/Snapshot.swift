#if DEBUG
import AppKit
import SwiftUI
import CastpaneCore

/// Debug builds only: `CASTPANE_SNAPSHOT=folder` draws the assistant and Settings to PNG
/// files (layout only: the glass is not in them) without starting the server, the capture core or a tunnel, then quits. It is how
/// the layout is checked (nothing may need a scroll bar) without opening the real app.
@MainActor
enum Snapshot {
    static func run(_ model: AppModel, to folder: URL) {
        try? FileManager.default.createDirectory(at: folder, withIntermediateDirectories: true)
        let now = Date().timeIntervalSince1970 * 1000
        GlassLook.plain = true
        // A bare binary has no bundle icon; use the one the app is built with.
        let icon = URL(fileURLWithPath: #filePath).deletingLastPathComponent()
            .appendingPathComponent("../../Resources/AppIcon.icns").standardized
        if let image = NSImage(contentsOf: icon) { NSApp.applicationIconImage = image }
        model.showSample(activity: ActivityItem.decodeList(Data("""
            [{"at": \(now - 90_000), "kind": "remote-end", "username": "admin", "reason": "page left"},
             {"at": \(now - 700_000), "kind": "remote-open", "username": "admin", "ip": "203.0.113.7"},
             {"at": \(now - 760_000), "kind": "sign-in", "username": "admin", "method": "password", "ip": "203.0.113.7"}]
            """.utf8)), quickURL: "https://quiet-river-sample-words.trycloudflare.com")
        var shots: [(String, NSSize, AnyView)] = []
        for step in 0..<5 { shots.append(("wizard-\(step)", Wizard.size, AnyView(Wizard(step: step)))) }
        for step in [0, 2, 3] { shots.append(("wizard-member-\(step)", Wizard.size, AnyView(Wizard(step: step, role: .member)))) }
        for mode in ConnectionMode.allCases {
            shots.append(("connection-\(mode.rawValue)", Wizard.size,
                          AnyView(ConnectionPane(showLog: true, initialMode: mode).padding(28).frame(width: Wizard.size.width, height: 400).background(WindowBackdrop()))))
        }
        for page in SettingsView.Page.allCases {
            shots.append(("settings-\(page.id.rawValue.lowercased())", SettingsView.size, AnyView(SettingsView(page: page, loadsActivity: false))))
        }
        var joined = MemberStatus(); joined.state = "connected"; joined.hub = "https://studio.example.ts.net"
        shots.append(("settings-connection-member", SettingsView.size, AnyView(SettingsView(page: .connection, loadsActivity: false, member: joined))))
        shots.append(("tunnel-log", NSSize(width: 560, height: 380), AnyView(TunnelLogSheet())))
        shots.append(("qr", NSSize(width: 340, height: 400),
                      AnyView(AddressCard(showQR: true, qrSize: 220).padding(24).frame(maxWidth: .infinity, maxHeight: .infinity).background(WindowBackdrop()))))
        Task { @MainActor in
            for (look, appearance) in [("dark", NSAppearance.Name.darkAqua), ("light", .aqua)] {
            NSApp.appearance = NSAppearance(named: appearance)
            for (shot, size, view) in shots {
                let name = "\(look)-\(shot)"
                let w = NSWindow(contentRect: NSRect(origin: NSPoint(x: -20000, y: 0), size: size),
                                 styleMask: [.titled, .closable, .fullSizeContentView], backing: .buffered, defer: false)
                w.titlebarAppearsTransparent = true
                w.isReleasedWhenClosed = false
                w.contentView = NSHostingView(rootView: view.environmentObject(model).tint(Palette.blue).background(Palette.paper))
                w.orderFront(nil)
                try? await Task.sleep(for: .milliseconds(600))
                // Drawn by the views themselves: right for the layout, but without the glass,
                // which the window server adds.
                let v = w.contentView!
                if let rep = v.bitmapImageRepForCachingDisplay(in: v.bounds) {
                    v.cacheDisplay(in: v.bounds, to: rep)
                    try? rep.representation(using: .png, properties: [:])?.write(to: folder.appendingPathComponent("\(name).png"))
                }
                w.close()
            }
            }
            exit(0)
        }
    }
}
#endif
