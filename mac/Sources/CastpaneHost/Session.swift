import Foundation
import AppKit
import ScreenCaptureKit
import ApplicationServices
import os

// One viewer's session, as the server relays it: hello first, then the page's requests.
// The protocol is CC Remote's, unchanged.

func sameBytes(_ a: String, _ b: String) -> Bool {
    let x = Array(a.utf8), y = Array(b.utf8)
    guard x.count == y.count else { return false }
    var diff: UInt8 = 0
    for i in 0..<x.count { diff |= x[i] ^ y[i] }
    return diff == 0
}

/// The video path's state: the encoder of the picture being shown and the frames not yet
/// acknowledged. The capture queue asks it for every frame, so it has a lock of its own
/// rather than waiting for the session.
final class VideoGate: @unchecked Sendable {
    private let lock = NSLock()
    private var encoder: ScreenEncoder?
    /// When each frame not yet acknowledged was let through, oldest first (the page
    /// acknowledges them in order).
    private var sent: [TimeInterval] = []
    private var lastAck: TimeInterval = 0
    /// Recent round trips (when measured, how long), for the shortest of the last few seconds.
    private var trips: [(at: TimeInterval, took: TimeInterval)] = []

    /// Frames that may be unshown at once: always 3, more when the round trip is long. Three
    /// was the limit for every link; over a long one (a Mac joined through another, by way of
    /// Cloudflare, about 0.3 s there and back) that held the picture to 8 to 10 frames a
    /// second however small they were (the owner's report, 2026-10-30). The shortest recent
    /// round trip is what the link takes without a queue: enough frames to cover it, and two
    /// more, keep it busy without letting a queue build up behind a slow one.
    static let fewest = 3, most = 16

    func window(fps: Int, now: TimeInterval) -> Int {
        guard let shortest = trips.lazy.filter({ now - $0.at < 3 }).map(\.took).min() else { return Self.fewest }
        return min(Self.most, max(Self.fewest, Int((shortest * Double(max(1, fps))).rounded(.up)) + 2))
    }

    /// Puts `next` in place (nil: none) and returns the one it replaced.
    func replace(with next: ScreenEncoder?, now: TimeInterval = ProcessInfo.processInfo.systemUptime) -> ScreenEncoder? {
        lock.withLock {
            // The second without an answer counts from here: from 0 it had always run out, and
            // the first frames past the window were let through with a key frame asked for.
            defer { encoder = next; sent = []; lastAck = now }
            return encoder
        }
    }

    func ack(now: TimeInterval = ProcessInfo.processInfo.systemUptime) {
        lock.withLock {
            lastAck = now
            guard !sent.isEmpty else { return }
            trips.append((now, now - sent.removeFirst()))
            trips.removeAll { now - $0.at > 3 }
        }
    }

    /// Asked when the page or the server lost a frame: start clean, and forget the frames
    /// that will never be acknowledged.
    func keyFrame() {
        let enc = lock.withLock { () -> ScreenEncoder? in sent = []; return encoder }
        enc?.requestKeyFrame()
    }

    /// The encoder to give this frame to, or nil to skip it. The page acknowledges each
    /// frame it shows: with a window's worth not yet shown, or a link that has not written
    /// what it has, the frame is skipped rather than queued. No answer for a second while
    /// frames are out (one lost on the way): start again from a key frame. A still copy
    /// (Capture's sharpening) goes only with nothing unshown and nothing unwritten, so it
    /// never holds up the frames of a picture that moves again.
    func admit(linkPending: Int, still: Bool = false, now: TimeInterval = ProcessInfo.processInfo.systemUptime) -> ScreenEncoder? {
        lock.withLock {
            guard let enc = encoder else { return nil }
            let limit = window(fps: enc.settings.fps, now: now)
            if sent.count >= limit && now - lastAck > 1 { sent = []; lastAck = now; enc.requestKeyFrame() }
            guard sent.count < limit, linkPending <= 2_000_000, !still || (sent.isEmpty && linkPending == 0) else { return nil }
            sent.append(now)
            return enc
        }
    }
}

/// One connection from the server: hello first, then the page's requests.
///
/// Everything the session keeps (what is shown, where its window is, the pending caret
/// report, the window watcher) and every use of `Input` is isolated to this actor. The
/// reader thread only checks the hello and parses; requests then reach the actor through
/// one stream, in the order they came. The video path (capture queue, encoder callbacks)
/// touches only `VideoGate`, `Capture` and `Link`, which have locks of their own.
actor Session {
    private enum Event: Sendable { case hello, request(Request), end }

    nonisolated let link: Link
    private nonisolated let token: String
    private nonisolated let onHello: @Sendable () -> Bool
    private nonisolated let trusted = OSAllocatedUnfairLock(initialState: false)
    private nonisolated let events: AsyncStream<Event>
    private nonisolated let feed: AsyncStream<Event>.Continuation
    private nonisolated let video = VideoGate()
    private nonisolated let capture = Capture()

    private let input = Input()
    private var target: Catalog.Target?
    private var windowFrame: CGRect?
    private var frameCheckedAt: TimeInterval = 0
    /// Starts and stops one after another: two quick picks never share the capture.
    private var chain: Task<Void, Never>?
    private var caretPending = false
    private var watcher: Task<Void, Never>?
    private var lastSignature = ""
    private var lastListed = Date.distantPast
    /// What the picture shown was started with, and the displays' arrangement then: a
    /// display shown is started again when that changes.
    private var lastStart: (kind: String, id: Int, maxWidth: Int, fps: Int, bitrate: Int, hevc: Bool)?
    private var displaysAtStart = ""
    private var wokenAt = Date.distantPast

    /// `onHello` runs once, on the reader's thread, when the hello carried the token and
    /// before anything is answered; false (the server stopped meanwhile) ends the session.
    init(link: Link, token: String, onHello: @escaping @Sendable () -> Bool) {
        self.link = link
        self.token = token
        self.onHello = onHello
        (events, feed) = AsyncStream.makeStream(of: Event.self)
        let video = self.video
        capture.setHandlers(onFrame: { [link] pixels, time, still in
            guard let enc = video.admit(linkPending: link.pending, still: still) else { return false }
            enc.encode(pixels, at: time)
            return true
        }, onStop: { [link] reason in
            link.send(json: ["t": "stopped", "reason": reason])
        })
    }

    /// Starts handling what `handle` passes on. Call once, before the reader starts.
    nonisolated func begin() {
        Task { await self.run() }
    }

    /// Whether the hello was good (read by the hello timeout, from another thread).
    nonisolated var isTrusted: Bool { trusted.withLock { $0 } }

    /// On the reader's thread: the hello is checked here, everything after it is parsed
    /// and passed on in order.
    nonisolated func handle(_ kind: Kind, _ payload: Data) {
        guard kind == .json, let msg = (try? JSONSerialization.jsonObject(with: payload)) as? [String: Any], let t = msg["t"] as? String else {
            link.close(); return
        }
        if !isTrusted {
            guard t == "hello", let given = msg["token"] as? String, sameBytes(given, token) else { link.close(); return }
            trusted.withLock { $0 = true }
            guard onHello() else { link.close(); return }
            feed.yield(.hello)
            return
        }
        // A malformed request is answered with an error (start) or dropped, never acted on.
        guard let request = Request.parse(msg) else { return }
        feed.yield(.request(request))
    }

    /// The connection ended: stop after whatever start is under way, on the session
    /// itself, so input is never let go of while a request still uses it.
    nonisolated func end() {
        feed.yield(.end)
        feed.finish()
    }

    private func run() async {
        for await event in events {
            switch event {
            case .hello:
                link.send(json: Self.status())
                if Wake.needed { Wake.display() }
                watchWindows()
            case .request(let r):
                route(r)
            case .end:
                watcher?.cancel()
                queued { await self.stop() }
            }
        }
    }

    /// The windows as the page should see them, without asking: when one opens, closes,
    /// is renamed or changes desktop (checked every 1.5 s, cheaply), and every 20 s for
    /// fresh thumbnails.
    private func watchWindows() {
        watcher = Task {
            while !Task.isCancelled && !link.isClosed {
                try? await Task.sleep(nanoseconds: 1_500_000_000)
                checkWindows()
            }
        }
    }

    private func checkWindows() {
        guard !link.isClosed, CGPreflightScreenCaptureAccess() else { return }
        // Someone is watching: the display stays on, at the lock screen too (which turns it
        // off after a minute whatever else asks it not to).
        if Date().timeIntervalSince(wokenAt) > 10, Wake.needed {
            wokenAt = Date()
            Wake.display()
        }
        // The Mac's own resolution changed while a display was shown: the clicks went where
        // the old size put them, and the picture kept its old shape, until a reconnect (the
        // owner's report, 2026-10-30). The same display is started again at its new size.
        if let s = lastStart, s.kind == "display", target != nil, Self.displaysSignature() != displaysAtStart {
            queued { await self.start(kind: s.kind, id: s.id, maxWidth: s.maxWidth, fps: s.fps, bitrate: s.bitrate, hevc: s.hevc) }
        }
        let sig = Self.windowSignature()
        if sig != lastSignature || Date().timeIntervalSince(lastListed) > 20 {
            let first = lastSignature.isEmpty
            lastSignature = sig
            if !first { route(.list) } else { lastListed = Date() }
        }
    }

    private static func windowSignature() -> String {
        guard let info = CGWindowListCopyWindowInfo([.optionAll, .excludeDesktopElements], kCGNullWindowID) as? [[String: Any]] else { return "" }
        return info.compactMap { w -> String? in
            guard (w[kCGWindowLayer as String] as? Int) == 0, let name = w[kCGWindowName as String] as? String, !name.isEmpty else { return nil }
            return "\(w[kCGWindowNumber as String] ?? 0):\(name):\(w[kCGWindowIsOnscreen as String] as? Bool ?? false)"
        }.sorted().joined(separator: "|")
    }

    /// Wakes the displays of a Mac that is asleep or locked, and waits (at most 3 s) until
    /// the capture sees them again: asleep, it lists none.
    private static func wakeDisplays() async {
        guard Wake.needed else { return }
        Wake.display()
        for _ in 0..<12 {
            if let c = try? await Catalog.content(), !c.displays.isEmpty { return }
            try? await Task.sleep(nanoseconds: 250_000_000)
        }
    }

    /// Every active display's place and size in points and pixels.
    private static func displaysSignature() -> String {
        var ids = [CGDirectDisplayID](repeating: 0, count: 16), count: UInt32 = 0
        guard CGGetActiveDisplayList(16, &ids, &count) == .success else { return "" }
        return ids.prefix(Int(count)).map { "\($0):\(CGDisplayBounds($0)):\(CGDisplayPixelsWide($0))" }.joined(separator: "|")
    }

    private static func status() -> [String: Any] {
        ["t": "status", "version": HostServer.version, "screen": CGPreflightScreenCaptureAccess(), "accessibility": AXIsProcessTrusted(),
         "host": Host.current().localizedName ?? "Mac"]
    }

    private func route(_ request: Request) {
        switch request {
        case .status: link.send(json: Self.status())
        case .permissions:
            let link = self.link
            Task { @MainActor in
                if !CGPreflightScreenCaptureAccess() { _ = CGRequestScreenCaptureAccess() }
                _ = AXIsProcessTrustedWithOptions(["AXTrustedCheckOptionPrompt": true] as CFDictionary)
                link.send(json: Self.status())
            }
        case .list:
            lastListed = Date()
            let link = self.link
            Task.detached {
                await Self.wakeDisplays()
                do { link.send(json: ["t": "list", "items": try await Catalog.list()]) }
                catch { link.send(json: ["t": "error", "where": "list", "message": error.localizedDescription]) }
            }
        case let .start(kind, id, maxWidth, fps, bitrate, hevc):
            queued { await self.start(kind: kind, id: id, maxWidth: maxWidth, fps: fps, bitrate: bitrate, hevc: hevc) }
        case .stop: queued { await self.stop() }
        case .ack: video.ack()
        case .keyFrame: video.keyFrame()
        case let .move(x, y):
            if let p = place(x, y) { input.move(to: p) }
        case let .button(b, down, x, y):
            if let p = place(x, y) {
                input.button(b, down: down, at: p)
                // After a click, whether a text field now has the focus: the page offers its keyboard.
                if !down {
                    Task {
                        try? await Task.sleep(nanoseconds: 250_000_000)
                        var msg: [String: Any] = ["t": "focus", "editable": input.focusEditable()]
                        if let c = caretInPicture() { msg["caret"] = c }
                        link.send(json: msg)
                    }
                }
            }
        // Asked as a finger touches down: is there a text field under it? (An iPhone opens
        // its keyboard only in the tap itself, so the page must know before the finger lifts.)
        case let .probe(x, y, n):
            if let p = place(x, y) { link.send(json: ["t": "probe", "editable": input.editable(at: p), "n": n]) }
        case let .scroll(dx, dy, x, y):
            if let p = place(x, y) { input.scroll(dx: dx, dy: dy, at: p) }
        case let .key(code, down, mods):
            input.key(code: code, down: down, mods: mods); if !down { reportCaret() }
        case let .text(s):
            input.type(s); reportCaret()
        case .clipboardGet:
            let link = self.link
            Task { @MainActor in
                var msg: [String: Any] = ["t": "clipboard"]
                switch Clipboard.read() {
                case let .text(s, truncated): msg["s"] = s; if truncated { msg["truncated"] = true }
                case .empty: msg["empty"] = true
                case .concealed: msg["concealed"] = true
                case .notAllowed: msg["notAllowed"] = true
                case .denied: msg["denied"] = true
                }
                if !JSONSerialization.isValidJSONObject(msg) { msg = ["t": "clipboard", "error": true] }
                link.send(json: msg)
            }
        case let .clipboardSet(s):
            let link = self.link
            Task { @MainActor in Clipboard.write(s); link.send(json: ["t": "clipboard-set"]) }
        case .invalid(let t):
            if t == "start" { link.send(json: ["t": "error", "where": "start", "message": "invalid request"]) }
        }
    }

    private func queued(_ job: @escaping @Sendable () async -> Void) {
        let previous = chain
        chain = Task { await previous?.value; await job() }
    }

    /// The text cursor as 0…1 across the picture [x, y, w, h], if it is in what is shown.
    private func caretInPicture() -> [Double]? {
        guard let target, let r = input.caret() else { return nil }
        var frame = target.frame
        if let id = target.windowID { frame = Catalog.frame(of: id) ?? frame }
        guard frame.width > 0, frame.height > 0, frame.intersects(r) else { return nil }
        let c: [Double] = [(r.minX - frame.minX) / frame.width, (r.minY - frame.minY) / frame.height, r.width / frame.width, r.height / frame.height]
        return c.allSatisfy(\.isFinite) ? c : nil
    }

    /// After typing, where the cursor went (once things settle), so the page can follow it.
    private func reportCaret() {
        if caretPending { return }
        caretPending = true
        Task {
            try? await Task.sleep(nanoseconds: 150_000_000)
            caretPending = false
            if let c = caretInPicture() { link.send(json: ["t": "caret", "caret": c]) }
        }
    }

    /// Where 0…1 across the picture is on screen now.
    private func place(_ x: Double, _ y: Double) -> CGPoint? {
        guard let target else { return nil }
        var rect = target.frame
        if let id = target.windowID {
            let now = ProcessInfo.processInfo.systemUptime
            if now - frameCheckedAt > 0.5 { windowFrame = Catalog.frame(of: id); frameCheckedAt = now }
            rect = windowFrame ?? rect
        }
        return input.point(x, y, in: rect)
    }

    /// The bitrate asked for is for a 1920 × 1080 picture; a larger one gets more, though
    /// less than in proportion (its detail is finer, not all new), at most 40 Mbps.
    static func scaledBitrate(_ bitrate: Int, width: Int, height: Int) -> Int {
        let more = pow(max(1, Double(width * height) / (1920 * 1080)), 0.75)
        return min(40_000_000, Int(Double(bitrate) * more))
    }

    private func start(kind: String, id: Int, maxWidth: Int, fps: Int, bitrate: Int, hevc: Bool) async {
        await stop()
        await Self.wakeDisplays()
        lastStart = (kind, id, maxWidth, fps, bitrate, hevc)
        displaysAtStart = Self.displaysSignature()
        do {
            guard let found = try await Catalog.target(kind: kind, id: id) else {
                link.send(json: ["t": "error", "where": "start", "message": "gone"]); return
            }
            // Pixels, not points: a Retina display's full detail, scaled down to fit maxWidth.
            let backing = await MainActor.run { NSScreen.main?.backingScaleFactor ?? 2 }
            let scale = kind == "display" && id != Catalog.allDisplays ? CGFloat(CGDisplayPixelsWide(CGDirectDisplayID(id))) / max(1, found.size.width) : backing
            var w = found.size.width * max(1, scale), h = found.size.height * max(1, scale)
            if w > CGFloat(maxWidth) { h = h * CGFloat(maxWidth) / w; w = CGFloat(maxWidth) }
            guard w.isFinite, h.isFinite else { link.send(json: ["t": "error", "where": "start", "message": "gone"]); return }
            let width = max(64, Int(min(w, 8192)) & ~1), height = max(64, Int(min(h, 8192)) & ~1)
            let link = self.link
            let output: ScreenEncoder.Output = { data, key, micros, codec in
                Self.sendVideo(link, data, key: key, micros: micros, codec: codec, width: width, height: height)
            }
            let settings = ScreenEncoder.Settings(width: width, height: height, fps: fps,
                                                  bitrate: Self.scaledBitrate(bitrate, width: width, height: height), hevc: hevc)
            // HEVC this Mac cannot encode (an older Intel Mac): H.264, which the page always takes.
            let enc = try (hevc ? try? ScreenEncoder(settings, output: output) : nil)
                ?? ScreenEncoder(.init(width: settings.width, height: settings.height, fps: fps, bitrate: settings.bitrate), output: output)
            video.replace(with: enc)?.invalidate()
            target = found
            windowFrame = nil
            frameCheckedAt = 0
            if let pid = found.pid, let wid = found.windowID {
                Catalog.bringForward(wid, pid: pid)
                // On another desktop or in the Dock: wait for macOS to bring it here.
                if !found.here { for _ in 0..<20 where !Catalog.isHere(wid) { try? await Task.sleep(nanoseconds: 100_000_000) } }
            }
            try await capture.start(found, width: width, height: height, fps: fps)
            link.send(json: ["t": "started", "kind": kind, "id": id, "width": width, "height": height, "fps": fps])
            // Whether a text field already has the focus, so the page knows where it starts.
            link.send(json: ["t": "focus", "editable": input.focusEditable(), "initial": true])
        } catch {
            link.send(json: ["t": "error", "where": "start", "message": error.localizedDescription])
        }
    }

    func stop() async {
        await capture.stop()
        video.replace(with: nil)?.invalidate()
        let t = target
        target = nil
        input.releaseAll(at: t.map { CGPoint(x: $0.frame.midX, y: $0.frame.midY) })
    }

    private static func sendVideo(_ link: Link, _ data: Data, key: Bool, micros: UInt64, codec: String?, width: Int, height: Int) {
        if let codec { link.send(json: ["t": "config", "codec": codec, "width": width, "height": height]) }
        var payload = Data(capacity: data.count + 9)
        payload.append(key ? 1 : 0)
        var ts = micros.bigEndian
        withUnsafeBytes(of: &ts) { payload.append(contentsOf: $0) }
        payload.append(data)
        link.send(kind: .video, payload: payload)
    }
}
