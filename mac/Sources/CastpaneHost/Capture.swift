import Foundation
import ScreenCaptureKit
import CoreMedia
import AppKit
import ApplicationServices

// The window number behind an Accessibility window (private, long-standing in macOS;
// the public API has no other way to match the two).
@_silgen_name("_AXUIElementGetWindow")
func _AXUIElementGetWindow(_ element: AXUIElement, _ id: UnsafeMutablePointer<CGWindowID>) -> AXError

// What can be shown (each display, and every ordinary window with a title), with a
// small picture of each for the page's bar, and the capture of the one picked.
enum Catalog {
    /// What to capture. SCContentFilter is an immutable description once made, so a
    /// target is passed between the session and the capture as a value.
    struct Target: @unchecked Sendable { let filter: SCContentFilter; let frame: CGRect; let size: CGSize; let windowID: CGWindowID?; let pid: pid_t?; var here = true }

    /// Every window, also those on the Mac's other desktops (Spaces) and in the Dock
    /// too: a window there is brought here when picked.
    static func content() async throws -> SCShareableContent {
        try await SCShareableContent.excludingDesktopWindows(true, onScreenWindowsOnly: false)
    }

    /// Ordinary windows: layer 0, with a title, big enough to use, not ours; the ones on
    /// this desktop first.
    static func windows(_ content: SCShareableContent) -> [SCWindow] {
        let me = ProcessInfo.processInfo.processIdentifier
        return content.windows.filter { w in
            w.windowLayer == 0 && !(w.title ?? "").isEmpty && w.frame.width >= 120 && w.frame.height >= 80
                && w.owningApplication != nil && w.owningApplication?.processID != me
                && !(w.owningApplication?.bundleIdentifier ?? "").hasPrefix("com.apple.WindowManager")
        }.sorted { a, b in a.isOnScreen && !b.isOnScreen }
    }

    static func list(thumbWidth: Int = 320) async throws -> [[String: Any]] {
        let content = try await content()
        var items: [[String: Any]] = []
        for (i, d) in content.displays.enumerated() {
            let filter = SCContentFilter(display: d, excludingWindows: [])
            items.append(["kind": "display", "id": Int(d.displayID), "title": content.displays.count > 1 ? "Desktop \(i + 1)" : "Desktop",
                          "app": "", "width": d.width, "height": d.height,
                          "thumb": await thumb(filter, CGSize(width: d.width, height: d.height), thumbWidth) ?? ""])
        }
        let desks = Spaces.desks()
        for w in windows(content) {
            let filter = SCContentFilter(desktopIndependentWindow: w)
            // Its desktop: number (per display), full screen, the one shown now; none in the Dock.
            var desk: [String: Any] = [:]
            if let id = Spaces.of(w.windowID), let d = desks[id] {
                desk = ["id": d.id, "number": d.number, "display": d.display, "fullscreen": d.fullscreen, "current": d.current]
            }
            items.append(["kind": "window", "id": Int(w.windowID), "title": w.title ?? "", "app": w.owningApplication?.applicationName ?? "",
                          "here": w.isOnScreen, "desk": desk,
                          "bundle": w.owningApplication?.bundleIdentifier ?? "",
                          "width": Int(w.frame.width), "height": Int(w.frame.height),
                          "thumb": await thumb(filter, w.frame.size, thumbWidth) ?? ""])
        }
        return items
    }

    static func target(kind: String, id: Int) async throws -> Target? {
        let content = try await content()
        if kind == "display", let d = content.displays.first(where: { Int($0.displayID) == id }) {
            return Target(filter: SCContentFilter(display: d, excludingWindows: []), frame: CGDisplayBounds(d.displayID),
                          size: CGSize(width: d.width, height: d.height), windowID: nil, pid: nil)
        }
        if kind == "window", let w = content.windows.first(where: { Int($0.windowID) == id }) {
            return Target(filter: SCContentFilter(desktopIndependentWindow: w), frame: w.frame, size: w.frame.size,
                          windowID: w.windowID, pid: w.owningApplication?.processID, here: w.isOnScreen)
        }
        return nil
    }

    /// Brings a window forward: out of the Dock if it was there, raised, its app in
    /// front, which also takes the Mac to the desktop (Space) the window is on.
    ///
    /// Each Accessibility call waits for the window's app to answer. It runs off the main
    /// thread, and waits a second at most: an app that hangs (found on a tester's Mac) must
    /// not freeze Castpane's menu, nor keep the viewer at "Switching…".
    static func bringForward(_ id: CGWindowID, pid: pid_t) {
        // Castpane's own windows (the setup assistant, Settings) are in the list too; they
        // need no raising, and activating Castpane would only pull its windows in front.
        guard pid != ProcessInfo.processInfo.processIdentifier else { return }
        let app = AXUIElementCreateApplication(pid)
        AXUIElementSetMessagingTimeout(app, 1)
        var value: CFTypeRef?
        if AXUIElementCopyAttributeValue(app, kAXWindowsAttribute as CFString, &value) == .success, let list = value as? [AXUIElement] {
            for w in list {
                var wid: CGWindowID = 0
                guard _AXUIElementGetWindow(w, &wid) == .success, wid == id else { continue }
                AXUIElementSetAttributeValue(w, kAXMinimizedAttribute as CFString, kCFBooleanFalse)
                AXUIElementPerformAction(w, kAXRaiseAction as CFString)
                AXUIElementSetAttributeValue(w, kAXMainAttribute as CFString, kCFBooleanTrue)
                break
            }
        }
        DispatchQueue.main.async { _ = NSRunningApplication(processIdentifier: pid)?.activate() }
    }

    /// Whether a window is on the screen now (after a switch of desktops).
    static func isHere(_ id: CGWindowID) -> Bool {
        guard let info = CGWindowListCopyWindowInfo([.optionIncludingWindow], id) as? [[String: Any]] else { return false }
        return (info.first?[kCGWindowIsOnscreen as String] as? Bool) ?? false
    }

    /// The window's frame now, in global top-left coordinates (it may have moved).
    static func frame(of windowID: CGWindowID) -> CGRect? {
        guard let info = CGWindowListCopyWindowInfo([.optionIncludingWindow], windowID) as? [[String: Any]],
              let bounds = info.first?[kCGWindowBounds as String] as? [String: CGFloat],
              let x = bounds["X"], let y = bounds["Y"], let w = bounds["Width"], let h = bounds["Height"] else { return nil }
        return CGRect(x: x, y: y, width: w, height: h)
    }

    private static func thumb(_ filter: SCContentFilter, _ size: CGSize, _ width: Int) async -> String? {
        guard size.width > 0, size.height > 0 else { return nil }
        let config = SCStreamConfiguration()
        config.width = width
        config.height = max(1, Int(CGFloat(width) * size.height / size.width))
        config.showsCursor = false
        guard let image = try? await SCScreenshotManager.captureImage(contentFilter: filter, configuration: config) else { return nil }
        let rep = NSBitmapImageRep(cgImage: image)
        guard let jpeg = rep.representation(using: .jpeg, properties: [.compressionFactor: 0.6]) else { return nil }
        return "data:image/jpeg;base64," + jpeg.base64EncodedString()
    }
}

/// The running stream, if any. Its start and stop come from the session (one after the
/// other); its frames and its end arrive on ScreenCaptureKit's queues: `stream` and the
/// handlers are behind a lock.
final class Capture: NSObject, SCStreamOutput, SCStreamDelegate, @unchecked Sendable {
    typealias FrameHandler = @Sendable (CVPixelBuffer, CMTime) -> Void
    typealias StopHandler = @Sendable (String) -> Void
    private let lock = NSLock()
    private var stream: SCStream?
    private var onFrame: FrameHandler?
    private var onStop: StopHandler?
    private let queue = DispatchQueue(label: "castpane.capture")

    func setHandlers(onFrame: @escaping FrameHandler, onStop: @escaping StopHandler) {
        lock.withLock { self.onFrame = onFrame; self.onStop = onStop }
    }

    func start(_ target: Catalog.Target, width: Int, height: Int, fps: Int) async throws {
        let config = SCStreamConfiguration()
        config.width = width
        config.height = height
        config.pixelFormat = kCVPixelFormatType_420YpCbCr8BiPlanarVideoRange
        config.minimumFrameInterval = CMTime(value: 1, timescale: CMTimeScale(fps))
        config.queueDepth = 5
        config.showsCursor = true
        let s = SCStream(filter: target.filter, configuration: config, delegate: self)
        try s.addStreamOutput(self, type: .screen, sampleHandlerQueue: queue)
        try await s.startCapture()
        lock.withLock { stream = s }
    }

    func stop() async {
        let s = lock.withLock { () -> SCStream? in defer { stream = nil }; return stream }
        guard let s else { return }
        try? await s.stopCapture()
    }

    func stream(_ stream: SCStream, didOutputSampleBuffer sample: CMSampleBuffer, of type: SCStreamOutputType) {
        guard type == .screen, sample.isValid, let pixels = CMSampleBufferGetImageBuffer(sample) else { return }
        // Only complete frames: idle and blank ones carry no picture.
        if let info = CMSampleBufferGetSampleAttachmentsArray(sample, createIfNecessary: false) as? [[SCStreamFrameInfo: Any]],
           let raw = info.first?[.status] as? Int, let status = SCFrameStatus(rawValue: raw), status != .complete { return }
        let handler = lock.withLock { onFrame }
        handler?(pixels, CMSampleBufferGetPresentationTimeStamp(sample))
    }

    func stream(_ stream: SCStream, didStopWithError error: Error) {
        let handler = lock.withLock { () -> StopHandler? in
            // Only the stream that is current: one already replaced says nothing.
            guard self.stream === stream else { return nil }
            self.stream = nil
            return onStop
        }
        handler?(error.localizedDescription)
    }
}
