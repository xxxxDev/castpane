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
    struct Target: @unchecked Sendable {
        let filter: SCContentFilter; let frame: CGRect; let size: CGSize; let windowID: CGWindowID?; let pid: pid_t?; var here = true
        /// All displays at once: each display's own filter and where it sits (global, top-left).
        var parts: [(filter: SCContentFilter, frame: CGRect)] = []
    }

    /// The id of "all displays": no display has it (kCGNullDirectDisplay).
    static let allDisplays = 0

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
        // Several displays: also all of them at once, side by side as arranged.
        if content.displays.count > 1 {
            let union = content.displays.map { CGDisplayBounds($0.displayID) }.reduce(CGRect.null) { $0.union($1) }
            items.append(["kind": "display", "id": allDisplays, "title": "All displays", "all": true, "app": "",
                          "width": Int(union.width), "height": Int(union.height),
                          "thumb": await thumbAll(content.displays, union, thumbWidth) ?? ""])
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
        if kind == "display", id == allDisplays, content.displays.count > 1 {
            let parts = content.displays.map { (filter: SCContentFilter(display: $0, excludingWindows: []), frame: CGDisplayBounds($0.displayID)) }
            let union = parts.map(\.frame).reduce(CGRect.null) { $0.union($1) }
            return Target(filter: parts[0].filter, frame: union, size: union.size, windowID: nil, pid: nil, parts: parts)
        }
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

    /// The displays' small pictures drawn where they sit, for "all displays".
    private static func thumbAll(_ displays: [SCDisplay], _ union: CGRect, _ width: Int) async -> String? {
        let scale = CGFloat(width) / max(1, union.width), height = max(1, Int(union.height * scale))
        guard let ctx = CGContext(data: nil, width: width, height: height, bitsPerComponent: 8, bytesPerRow: 0,
                                  space: CGColorSpaceCreateDeviceRGB(), bitmapInfo: CGImageAlphaInfo.premultipliedFirst.rawValue) else { return nil }
        ctx.setFillColor(CGColor(gray: 0, alpha: 1))
        ctx.fill(CGRect(x: 0, y: 0, width: width, height: height))
        for d in displays {
            let f = CGDisplayBounds(d.displayID)
            let r = CGRect(x: (f.minX - union.minX) * scale, y: CGFloat(height) - (f.maxY - union.minY) * scale, width: f.width * scale, height: f.height * scale)
            let config = SCStreamConfiguration()
            config.width = max(1, Int(r.width)); config.height = max(1, Int(r.height)); config.showsCursor = false
            if let image = try? await SCScreenshotManager.captureImage(contentFilter: SCContentFilter(display: d, excludingWindows: []), configuration: config) {
                ctx.draw(image, in: r)
            }
        }
        guard let image = ctx.makeImage() else { return nil }
        guard let jpeg = NSBitmapImageRep(cgImage: image).representation(using: .jpeg, properties: [.compressionFactor: 0.6]) else { return nil }
        return "data:image/jpeg;base64," + jpeg.base64EncodedString()
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

/// The running stream, if any, or one stream per display for "all displays", put side by
/// side into one picture. Its start and stop come from the session (one after the other);
/// its frames and its end arrive on ScreenCaptureKit's queues: the streams and the handlers
/// are behind a lock, and the frames of every stream come on one serial queue.
final class Capture: NSObject, SCStreamOutput, SCStreamDelegate, @unchecked Sendable {
    typealias FrameHandler = @Sendable (CVPixelBuffer, CMTime) -> Void
    typealias StopHandler = @Sendable (String) -> Void
    private let lock = NSLock()
    private var streams: [SCStream] = []
    private var onFrame: FrameHandler?
    private var onStop: StopHandler?
    private let queue = DispatchQueue(label: "castpane.capture")
    /// "All displays" only; used on `queue` alone.
    private var compositor: Compositor?

    func setHandlers(onFrame: @escaping FrameHandler, onStop: @escaping StopHandler) {
        lock.withLock { self.onFrame = onFrame; self.onStop = onStop }
    }

    func start(_ target: Catalog.Target, width: Int, height: Int, fps: Int) async throws {
        func config(_ w: Int, _ h: Int) -> SCStreamConfiguration {
            let c = SCStreamConfiguration()
            c.width = w
            c.height = h
            c.pixelFormat = kCVPixelFormatType_420YpCbCr8BiPlanarVideoRange
            c.minimumFrameInterval = CMTime(value: 1, timescale: CMTimeScale(fps))
            c.queueDepth = 5
            c.showsCursor = true
            return c
        }
        if target.parts.isEmpty {
            let s = SCStream(filter: target.filter, configuration: config(width, height), delegate: self)
            try s.addStreamOutput(self, type: .screen, sampleHandlerQueue: queue)
            try await s.startCapture()
            queue.sync { compositor = nil }
            lock.withLock { streams = [s] }
            return
        }
        // Each display at its share of the picture, drawn where it sits in the arrangement.
        let union = target.frame, sx = CGFloat(width) / max(1, union.width), sy = CGFloat(height) / max(1, union.height)
        var places: [CGRect] = []
        var started: [SCStream] = []
        do {
            for part in target.parts {
                let r = CGRect(x: (part.frame.minX - union.minX) * sx, y: (part.frame.minY - union.minY) * sy,
                               width: part.frame.width * sx, height: part.frame.height * sy)
                let s = SCStream(filter: part.filter, configuration: config(max(2, Int(r.width) & ~1), max(2, Int(r.height) & ~1)), delegate: self)
                try s.addStreamOutput(self, type: .screen, sampleHandlerQueue: queue)
                places.append(r)
                started.append(s)
            }
            let comp = try Compositor(width: width, height: height, places: places, streams: started.map(ObjectIdentifier.init), fps: fps)
            queue.sync { compositor = comp }
            for s in started { try await s.startCapture() }
        } catch {
            for s in started { try? await s.stopCapture() }
            queue.sync { compositor = nil }
            throw error
        }
        lock.withLock { streams = started }
    }

    func stop() async {
        let all = lock.withLock { () -> [SCStream] in defer { streams = [] }; return streams }
        for s in all { try? await s.stopCapture() }
        queue.sync { compositor = nil }
    }

    func stream(_ stream: SCStream, didOutputSampleBuffer sample: CMSampleBuffer, of type: SCStreamOutputType) {
        guard type == .screen, sample.isValid, let pixels = CMSampleBufferGetImageBuffer(sample) else { return }
        // Only complete frames: idle and blank ones carry no picture.
        if let info = CMSampleBufferGetSampleAttachmentsArray(sample, createIfNecessary: false) as? [[SCStreamFrameInfo: Any]],
           let raw = info.first?[.status] as? Int, let status = SCFrameStatus(rawValue: raw), status != .complete { return }
        let time = CMSampleBufferGetPresentationTimeStamp(sample)
        let handler = lock.withLock { onFrame }
        if let compositor {
            if let picture = compositor.add(pixels, from: ObjectIdentifier(stream), at: time) { handler?(picture, time) }
        } else {
            handler?(pixels, time)
        }
    }

    func stream(_ stream: SCStream, didStopWithError error: Error) {
        let handler = lock.withLock { () -> StopHandler? in
            // Only a stream that is current: one already replaced says nothing.
            guard streams.contains(where: { $0 === stream }) else { return nil }
            streams = []
            return onStop
        }
        handler?(error.localizedDescription)
    }
}

/// Puts the displays' latest frames side by side into one picture, at most `fps` times a
/// second. A display that has not changed keeps its last frame; one not yet seen is black.
final class Compositor {
    private let width: Int, height: Int
    private let places: [ObjectIdentifier: CGRect]
    private var latest: [ObjectIdentifier: CIImage] = [:]
    private let pool: CVPixelBufferPool
    private let context = CIContext(options: [.cacheIntermediates: false])
    private let interval: Double
    private var lastOut = -Double.infinity

    init(width: Int, height: Int, places: [CGRect], streams: [ObjectIdentifier], fps: Int) throws {
        self.width = width
        self.height = height
        var map: [ObjectIdentifier: CGRect] = [:]
        for (id, r) in zip(streams, places) { map[id] = r }
        self.places = map
        interval = 1 / Double(max(1, fps))
        let attrs: [String: Any] = [kCVPixelBufferPixelFormatTypeKey as String: kCVPixelFormatType_32BGRA,
                                    kCVPixelBufferWidthKey as String: width, kCVPixelBufferHeightKey as String: height,
                                    kCVPixelBufferIOSurfacePropertiesKey as String: [:]]
        var made: CVPixelBufferPool?
        CVPixelBufferPoolCreate(nil, [kCVPixelBufferPoolMinimumBufferCountKey as String: 3] as CFDictionary, attrs as CFDictionary, &made)
        guard let made else { throw NSError(domain: "castpane", code: 1, userInfo: [NSLocalizedDescriptionKey: "no picture buffers"]) }
        pool = made
    }

    /// The new picture, or nil when it is too soon after the last one.
    func add(_ pixels: CVPixelBuffer, from stream: ObjectIdentifier, at time: CMTime) -> CVPixelBuffer? {
        guard let place = places[stream] else { return nil }
        // A display's first frame always goes out: a display that does not change sends
        // no more, and would otherwise stay black until another one does.
        let first = latest[stream] == nil
        // Placed in the picture: Core Image counts from the bottom left.
        let image = CIImage(cvPixelBuffer: pixels)
        let sx = place.width / max(1, image.extent.width), sy = place.height / max(1, image.extent.height)
        latest[stream] = image.transformed(by: CGAffineTransform(scaleX: sx, y: sy)
            .concatenating(CGAffineTransform(translationX: place.minX, y: CGFloat(height) - place.maxY)))
        let now = time.seconds
        if !first, now.isFinite, now - lastOut < interval { return nil }
        lastOut = now.isFinite ? now : lastOut
        var out: CVPixelBuffer?
        CVPixelBufferPoolCreatePixelBuffer(nil, pool, &out)
        guard let out else { return nil }
        let frame = CGRect(x: 0, y: 0, width: width, height: height)
        let picture = latest.values.reduce(CIImage(color: .black).cropped(to: frame)) { $1.composited(over: $0) }
        context.render(picture, to: out, bounds: frame, colorSpace: CGColorSpaceCreateDeviceRGB())
        return out
    }
}
