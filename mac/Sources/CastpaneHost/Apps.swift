import Foundation
import AppKit
import ApplicationServices

// The Mac's apps for the page's home: those installed in the usual folders and those
// running, each with a small icon, and an app started on request. Only an app found
// this way can be started: the page names it by its bundle id, never by a path.
enum Apps {
    static let iconSize = 64
    private static let folders = ["/Applications", "/Applications/Utilities", "/System/Applications", "/System/Applications/Utilities",
                                  NSHomeDirectory() + "/Applications"]

    /// Installed and running apps by bundle id: name and whether it runs. The icons come
    /// apart (`icons`), only those the page has not kept: all at once were a megabyte.
    @MainActor static func list() -> [[String: Any]] { found().map { ["bundle": $0.id, "name": $0.name, "running": $0.running] } }

    /// Icons (PNG data URLs) of apps `found` gives, by bundle id; at most 40 at a time.
    @MainActor static func icons(_ bundles: [String]) -> [String: String] {
        let all = Dictionary(found().map { ($0.id, $0.url) }, uniquingKeysWith: { a, _ in a })
        var out: [String: String] = [:]
        for b in bundles.prefix(40) { if let url = all[b], let i = icon(url) { out[b] = i } }
        return out
    }

    @MainActor private static func found() -> [(id: String, name: String, url: URL, running: Bool)] {
        var found: [String: (name: String, url: URL)] = [:]
        for folder in folders {
            guard let names = try? FileManager.default.contentsOfDirectory(atPath: folder) else { continue }
            for n in names where n.hasSuffix(".app") {
                let url = URL(fileURLWithPath: folder).appendingPathComponent(n)
                guard let id = Bundle(url: url)?.bundleIdentifier, found[id] == nil else { continue }
                found[id] = (FileManager.default.displayName(atPath: url.path).replacingOccurrences(of: ".app", with: ""), url)
            }
        }
        var running = Set<String>()
        for app in NSWorkspace.shared.runningApplications where app.activationPolicy == .regular {
            guard let id = app.bundleIdentifier, id != Bundle.main.bundleIdentifier else { continue }
            running.insert(id)
            if found[id] == nil, let url = app.bundleURL { found[id] = (app.localizedName ?? url.deletingPathExtension().lastPathComponent, url) }
        }
        found.removeValue(forKey: Bundle.main.bundleIdentifier ?? "")
        return found.sorted { $0.value.name.localizedStandardCompare($1.value.name) == .orderedAscending }.prefix(300).map { id, v in
            (id, v.name, v.url, running.contains(id))
        }
    }

    @MainActor private static func icon(_ url: URL) -> String? {
        let image = NSWorkspace.shared.icon(forFile: url.path)
        guard let rep = NSBitmapImageRep(bitmapDataPlanes: nil, pixelsWide: iconSize, pixelsHigh: iconSize, bitsPerSample: 8, samplesPerPixel: 4,
                                         hasAlpha: true, isPlanar: false, colorSpaceName: .deviceRGB, bytesPerRow: 0, bitsPerPixel: 0) else { return nil }
        NSGraphicsContext.saveGraphicsState()
        NSGraphicsContext.current = NSGraphicsContext(bitmapImageRep: rep)
        image.draw(in: NSRect(x: 0, y: 0, width: iconSize, height: iconSize))
        NSGraphicsContext.restoreGraphicsState()
        guard let png = rep.representation(using: .png, properties: [:]) else { return nil }
        return "data:image/png;base64," + png.base64EncodedString()
    }

    /// Starts (or brings forward) the app with this bundle id, if it is one `list` gives.
    @MainActor static func launch(_ bundle: String) -> Bool {
        // The copy that was listed, not whichever one macOS would pick for the bundle id.
        guard let url = found().first(where: { $0.id == bundle })?.url else { return false }
        let config = NSWorkspace.OpenConfiguration()
        config.activates = true
        NSWorkspace.shared.openApplication(at: url, configuration: config)
        return true
    }
}

// A window made the shape of the device it is used from (a phone's tall and narrow), so
// its text is about the size of the device's own apps and a finger can hit its buttons;
// put back as it was when the page leaves it.
enum Fit {
    /// The Accessibility window behind a window number, waiting a second at most for its app.
    static func axWindow(_ id: CGWindowID, pid: pid_t) -> AXUIElement? {
        let app = AXUIElementCreateApplication(pid)
        AXUIElementSetMessagingTimeout(app, 1)
        var value: CFTypeRef?
        guard AXUIElementCopyAttributeValue(app, kAXWindowsAttribute as CFString, &value) == .success, let list = value as? [AXUIElement] else { return nil }
        for w in list {
            var wid: CGWindowID = 0
            if _AXUIElementGetWindow(w, &wid) == .success, wid == id { return w }
        }
        return nil
    }

    static func frame(_ w: AXUIElement) -> CGRect? {
        var pos: CFTypeRef?, size: CFTypeRef?
        var p = CGPoint.zero, s = CGSize.zero
        guard AXUIElementCopyAttributeValue(w, kAXPositionAttribute as CFString, &pos) == .success, let pos,
              AXUIElementCopyAttributeValue(w, kAXSizeAttribute as CFString, &size) == .success, let size,
              AXValueGetValue(pos as! AXValue, .cgPoint, &p), AXValueGetValue(size as! AXValue, .cgSize, &s) else { return nil }
        return CGRect(origin: p, size: s)
    }

    static func set(_ w: AXUIElement, _ r: CGRect) {
        var p = r.origin, s = r.size
        if let size = AXValueCreate(.cgSize, &s) { AXUIElementSetAttributeValue(w, kAXSizeAttribute as CFString, size) }
        if let pos = AXValueCreate(.cgPoint, &p) { AXUIElementSetAttributeValue(w, kAXPositionAttribute as CFString, pos) }
        // Some apps take the size only once the window is where it can have it.
        if let size = AXValueCreate(.cgSize, &s) { AXUIElementSetAttributeValue(w, kAXSizeAttribute as CFString, size) }
    }

    /// Whether a window is in full screen (its own desktop), and taking it in or out.
    static func isFullScreen(_ w: AXUIElement) -> Bool {
        var v: CFTypeRef?
        return AXUIElementCopyAttributeValue(w, "AXFullScreen" as CFString, &v) == .success && (v as? Bool) == true
    }
    static func setFullScreen(_ w: AXUIElement, _ on: Bool) {
        AXUIElementSetAttributeValue(w, "AXFullScreen" as CFString, on ? kCFBooleanTrue : kCFBooleanFalse)
    }

    /// Whether a window is in the Dock, and putting it there.
    static func isMinimized(_ w: AXUIElement) -> Bool {
        var v: CFTypeRef?
        return AXUIElementCopyAttributeValue(w, kAXMinimizedAttribute as CFString, &v) == .success && (v as? Bool) == true
    }
    static func minimize(_ w: AXUIElement) {
        AXUIElementSetAttributeValue(w, kAXMinimizedAttribute as CFString, kCFBooleanTrue)
    }

    /// Presses the window's close button.
    static func close(_ w: AXUIElement) {
        var button: CFTypeRef?
        if AXUIElementCopyAttributeValue(w, kAXCloseButtonAttribute as CFString, &button) == .success, let button {
            AXUIElementPerformAction(button as! AXUIElement, kAXPressAction as CFString)
        }
    }

    /// The usable part of the display a window is on (global, top-left), without the menu bar and Dock.
    @MainActor static func usable(for r: CGRect) -> CGRect {
        let top = NSScreen.screens.first?.frame.maxY ?? 0
        let screens = NSScreen.screens.map { s -> (CGRect, CGRect) in
            let f = s.frame, v = s.visibleFrame
            return (CGRect(x: f.minX, y: top - f.maxY, width: f.width, height: f.height), CGRect(x: v.minX, y: top - v.maxY, width: v.width, height: v.height))
        }
        let mid = CGPoint(x: r.midX, y: r.midY)
        return (screens.first { $0.0.contains(mid) } ?? screens.first)?.1 ?? r
    }

    /// Where a window of `size` goes: its top-left kept where it can be, inside `usable`.
    static func place(_ size: CGSize, from r: CGRect, in usable: CGRect) -> CGRect {
        let w = min(size.width, usable.width), h = min(size.height, usable.height)
        let x = min(max(r.minX, usable.minX), usable.maxX - w), y = min(max(r.minY, usable.minY), usable.maxY - h)
        return CGRect(x: x, y: y, width: w, height: h)
    }
}
