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
    /// second however small they were. The shortest recent
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
    /// Opens a Dock item on a queue of its own, off the main thread and off Swift's thread pool:
    /// macOS may first ask on the Mac whether Castpane may reach that folder (Downloads,
    /// Documents) and the call waits for the answer, however long. One at a time: while one is
    /// waiting, another is answered `asking` at once rather than queued. Not opened within three
    /// seconds: said, `asking`, and the outcome said again when it comes (`late`).
    private static let dockOpenQueue = DispatchQueue(label: "castpane.dock-open")
    private static let dockOpening = OSAllocatedUnfairLock(initialState: false)
    nonisolated static func openOffMain(_ link: Link, _ open: @escaping @Sendable () -> Bool) {
        guard dockOpening.withLock({ busy in if busy { return false }; busy = true; return true }) else {
            link.send(json: ["t": "dock-opened", "ok": false, "asking": true]); return
        }
        let first = OSAllocatedUnfairLock(initialState: true)
        let claim: @Sendable () -> Bool = { first.withLock { was in defer { was = false }; return was } }
        dockOpenQueue.async {
            let ok = open()
            dockOpening.withLock { $0 = false }
            if claim() { link.send(json: ["t": "dock-opened", "ok": ok]) } else { link.send(json: ["t": "dock-opened", "ok": ok, "late": true]) }
        }
        DispatchQueue.global().asyncAfter(deadline: .now() + 3) {
            if claim() { link.send(json: ["t": "dock-opened", "ok": false, "asking": true]) }
        }
    }

    /// A new window of an app, as its Dock menu's New Window: brought forward (started if it is
    /// not running, which opens its first window), then its menu item with ⌘N pressed, off the
    /// main thread (an app slow to answer Accessibility waits there, a second at most a call).
    private static let newWindowQueue = DispatchQueue(label: "castpane.new-window")
    nonisolated static func newWindow(_ link: Link, _ bundle: String) {
        newWindowQueue.async {
            // Only an app `apps` lists, and its copy running from where it is listed.
            let (listed, pid) = DispatchQueue.main.sync { MainActor.assumeIsolated { Apps.listed(bundle) } }
            guard listed else { link.send(json: ["t": "launched", "bundle": bundle, "ok": false, "newWindow": true]); return }
            guard let pid, let app = NSRunningApplication(processIdentifier: pid) else {
                let ok = DispatchQueue.main.sync { MainActor.assumeIsolated { Apps.launch(bundle) } }
                link.send(json: ["t": "launched", "bundle": bundle, "ok": ok]); return
            }
            DispatchQueue.main.sync { _ = app.activate() }
            for _ in 0..<20 where !app.isActive { Thread.sleep(forTimeInterval: 0.1) }
            link.send(json: ["t": "launched", "bundle": bundle, "ok": Apps.pressNewWindow(app.processIdentifier), "newWindow": true])
        }
    }

    /// The Dock's folders and files, read on a queue of their own (an item on a network disk
    /// gone can take long to check): while a reading is still going, the last one read is used.
    private static let dockReadQueue = DispatchQueue(label: "castpane.dock-read")
    private static let dockRead = OSAllocatedUnfairLock<(busy: Bool, last: [[String: String]])>(initialState: (false, []))
    nonisolated static func sendDock(_ link: Link) {
        let start = dockRead.withLock { state -> [[String: String]]? in if state.busy { return state.last }; state.busy = true; return nil }
        let send: @Sendable ([[String: String]]) -> Void = { others in
            DispatchQueue.main.async { MainActor.assumeIsolated { link.send(json: ["t": "dock", "apps": Apps.dock(), "others": others, "trash": true]) } }
        }
        if let cached = start { send(cached); return }
        dockReadQueue.async {
            let others = Apps.dockOthers().map { ["name": $0.name, "kind": $0.folder ? "folder" : "file"] }
            dockRead.withLock { $0 = (false, others) }
            send(others)
        }
    }


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
    private var clipboardWatcher: Task<Void, Never>?
    private var clipboardSeen = 0
    private var lastSignature = ""
    private var lastListed = Date.distantPast
    /// What the picture shown was started with, and the displays' arrangement then: a
    /// display shown is started again when that changes.
    private var lastStart: (kind: String, id: Int, maxWidth: Int, fps: Int, bitrate: Int, hevc: Bool)?
    private var displaysAtStart = ""
    private var wokenAt = Date.distantPast
    /// The window made the device's shape, and its frame before, to put back.
    private var fitted: (id: CGWindowID, pid: pid_t, was: CGRect, fullScreen: Bool)?
    /// The app that was in front before a window was brought forward for the viewer: put
    /// back in front (and its desktop with it) when the viewer leaves the windows.
    private var inFront: pid_t?
    /// The window brought forward and how it was out of sight before: its app hidden, the
    /// window in the Dock, or closed with its app left running (Teams, Jump Desktop). It
    /// goes back so when the viewer leaves it or turns to another window.
    private var away: (id: CGWindowID, pid: pid_t, how: Away)?
    private enum Away { case hidden, minimized, closed }

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
                watchClipboard()
            case .request(let r):
                route(r)
            case .end:
                watcher?.cancel()
                clipboardWatcher?.cancel()
                queued { await self.unfit(); await self.stop(); await self.restore(); Self.relock() }
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
                checkLocked()
                checkWindows()
            }
        }
    }

    /// Tells the page when the Mac's clipboard changes, so a paste there brings what was just
    /// copied on the Mac. Only the count is read: it needs no
    /// permission and says nothing of what is on the clipboard.
    private func watchClipboard() {
        clipboardWatcher = Task {
            clipboardSeen = await MainActor.run { NSPasteboard.general.changeCount }
            while !Task.isCancelled && !link.isClosed {
                try? await Task.sleep(nanoseconds: 250_000_000)
                let count = await MainActor.run { NSPasteboard.general.changeCount }
                if count != clipboardSeen { clipboardSeen = count; link.send(json: ["t": "clipboard-changed"]) }
            }
        }
    }

    private func clipboardWritten(_ count: Int) { clipboardSeen = count }

    /// Tells the page when the Mac locks or unlocks, so it can ask for the password.
    private var lockedSent = false
    private func checkLocked() {
        let now = Wake.locked
        if now != lockedSent { lockedSent = now; link.send(json: ["t": "locked", "locked": now]) }
    }

    /// One password try at a time for the whole app, every viewer's together, and one every
    /// 3 seconds at most.
    private static let unlockGate = OSAllocatedUnfairLock(initialState: (busy: false, last: Date.distantPast))
    /// A Mac unlocked from Remote, or used at its lock screen from Remote, is locked again
    /// when that viewer leaves (or when Castpane stops). One a person unlocked at the Mac
    /// itself is left alone.
    private static let relockPending = OSAllocatedUnfairLock(initialState: false)

    /// The password typed into the lock screen (woken first), and whether the Mac unlocked.
    /// Each key goes only while the Mac is still locked: a Mac unlocked meanwhile (by its
    /// owner at the keyboard, or by another viewer's try) must not get the password, and
    /// its Return, in the app in front.
    private func unlock(_ password: String) async {
        guard Wake.locked else { link.send(json: ["t": "unlocked", "ok": true]); return }
        let go = Self.unlockGate.withLock { g -> Bool in
            guard !g.busy, Date().timeIntervalSince(g.last) >= 3 else { return false }
            g = (true, Date()); return true
        }
        guard go else { link.send(json: ["t": "unlocked", "ok": false, "busy": true]); return }
        defer { Self.unlockGate.withLock { $0.busy = false } }
        Wake.display()
        try? await Task.sleep(nanoseconds: 900_000_000)
        let link = self.link
        let stillLocked = { !link.isClosed && Wake.locked }
        guard stillLocked() else { link.send(json: ["t": "unlocked", "ok": !Wake.locked]); return }
        Self.relockPending.withLock { $0 = true }
        guard input.typeKeys(password, while: stillLocked), stillLocked() else { link.send(json: ["t": "unlocked", "ok": !Wake.locked]); return }
        input.key(code: "Enter", down: true, mods: []); input.key(code: "Enter", down: false, mods: [])
        var ok = false
        for _ in 0..<40 { try? await Task.sleep(nanoseconds: 150_000_000); if !Wake.locked { ok = true; break } }
        if ok { lockedSent = false }
        link.send(json: ["t": "unlocked", "ok": ok])
        if ok { link.send(json: ["t": "locked", "locked": false]) }
    }

    /// Input from the viewer while the Mac is locked: its lock screen used from Remote.
    private func noteLockedInput() {
        if Wake.locked { Self.relockPending.withLock { $0 = true } }
    }

    /// Locked again as it was found, when it was unlocked from Remote. Also run when
    /// Castpane stops, which a viewer's queued end might not wait for.
    static func relock() {
        // Still locked while a password is being checked: kept for the relock after it.
        let locked = Wake.locked, checking = unlockGate.withLock { $0.busy }
        guard relockPending.withLock({ p -> Bool in let was = p; if !(locked && checking) { p = false }; return was }), !locked else { return }
        if !Lock.now() { log.error("the Mac could not be locked again after Remote unlocked it") }
    }
    fileprivate static let log = Logger(subsystem: "io.github.castpane", category: "session")

    private func checkWindows() {
        guard !link.isClosed, CGPreflightScreenCaptureAccess() else { return }
        // Someone is watching: the display stays on, at the lock screen too (which turns it
        // off after a minute whatever else asks it not to).
        if Date().timeIntervalSince(wokenAt) > 10, Wake.needed {
            wokenAt = Date()
            Wake.display()
        }
        // The Mac's own resolution changed while a display was shown: the clicks went where
        // the old size put them, and the picture kept its old shape, until a reconnect.
        // The same display is started again at its new size.
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
    @discardableResult
    private static func wakeDisplays() async -> String {
        guard let why = Wake.why else { return "awake" }
        Wake.display()
        let until = Date().addingTimeInterval(3)
        while Date() < until {
            if let c = try? await Catalog.within(1, { Catalog.Unchecked(try await Catalog.content()) }), !c.value.displays.isEmpty { return why }
            try? await Task.sleep(nanoseconds: 250_000_000)
        }
        return why + ", still"
    }

    /// Every active display's place and size in points and pixels.
    private static func displaysSignature() -> String {
        var ids = [CGDirectDisplayID](repeating: 0, count: 16), count: UInt32 = 0
        guard CGGetActiveDisplayList(16, &ids, &count) == .success else { return "" }
        return ids.prefix(Int(count)).map { "\($0):\(CGDisplayBounds($0)):\(CGDisplayPixelsWide($0))" }.joined(separator: "|")
    }

    private static func status() -> [String: Any] {
        ["t": "status", "version": HostServer.version, "screen": CGPreflightScreenCaptureAccess(), "accessibility": AXIsProcessTrusted(),
         "host": Host.current().localizedName ?? "Mac",
         // minimize, quit and dock are known here: a page asks for them only then (a Mac from
         // before ends the session on a request it does not know).
         "windows": true]
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
        case let .shots(ids, width):
            let link = self.link
            Task.detached { link.send(json: ["t": "shots", "items": await Catalog.shots(ids.map { CGWindowID($0) }, width: width)]) }
        case .list, .listSized:
            lastListed = Date()
            let link = self.link
            let width: Int = if case .listSized(let w) = request { w } else { 320 }
            Task.detached {
                await Self.wakeDisplays()
                do { link.send(json: ["t": "list", "items": try await Catalog.list(thumbWidth: width)]) }
                catch { link.send(json: ["t": "error", "where": "list", "message": error.localizedDescription]) }
            }
        case let .start(kind, id, maxWidth, fps, bitrate, hevc, cursor):
            queued { await self.start(kind: kind, id: id, maxWidth: maxWidth, fps: fps, bitrate: bitrate, hevc: hevc, cursor: cursor) }
        case .stop: queued { await self.unfit(); await self.stop(); await self.restore() }
        case .apps:
            let link = self.link
            Task { @MainActor in link.send(json: ["t": "apps", "apps": Apps.list()]) }
        case let .icons(bundles):
            let link = self.link
            Task { @MainActor in link.send(json: ["t": "icons", "icons": Apps.icons(bundles)]) }
        case let .launch(bundle, newWindow):
            let link = self.link
            if newWindow { Self.newWindow(link, bundle);break }
            Task { @MainActor in link.send(json: ["t": "launched", "bundle": bundle, "ok": Apps.launch(bundle)]) }
        case let .fit(id, width, height): queued { await self.fit(CGWindowID(id), CGSize(width: width, height: height)) }
        case .unfit: queued { await self.unfit() }
        case let .close(id): queued { await self.close(CGWindowID(id)) }
        case let .minimize(id): queued { await self.minimize(CGWindowID(id)) }
        case .dock:
            // The folders and files at the Dock's right by name and kind only (no path), then
            // the Trash; opened by their place with dock-open.
            Self.sendDock(link)
        case let .dockOpen(index, name):
            Self.openOffMain(link) { Apps.openDockOther(index, name: name) }
        case .dockOpenTrash:
            Self.openOffMain(link) { Apps.openTrash() }
        case let .quit(bundle, force):
            let link = self.link
            Task { @MainActor in
                let asked = Apps.quit(bundle, force: force)
                link.send(json: ["t": "quit", "bundle": bundle, "ok": asked])
                // Its windows go as it quits; one with unsaved documents asks on the Mac and stays.
                try? await Task.sleep(nanoseconds: 800_000_000)
                guard !link.isClosed else { return }
                // Asked and still running: it is asking something (iTerm2's "Quit iTerm2?", a
                // document to save). Brought to the front so its question is where the whole
                // screen shows it. One refused (the Finder) is left where it is.
                if asked && !force { Apps.bringForwardIfRunning(bundle) }
                await self.route(.list)
            }
        case .ack: video.ack()
        case .keyFrame: video.keyFrame()
        case let .move(x, y):
            if let p = place(x, y) { input.move(to: p) }
        case let .button(b, down, x, y):
            if down { noteLockedInput() }
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
            if down { noteLockedInput() }
            input.key(code: code, down: down, mods: mods); if !down { reportCaret() }
        case let .text(s):
            noteLockedInput(); input.type(s); reportCaret()
        case let .unlock(password):
            queued { await self.unlock(password) }
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
            Task { @MainActor in
                Clipboard.write(s)
                await self.clipboardWritten(NSPasteboard.general.changeCount)
                link.send(json: ["t": "clipboard-set"])
            }
        case .invalid(let t):
            if t == "start" { link.send(json: ["t": "error", "where": "start", "message": "invalid request"]) }
        }
    }

    /// How long each step of a fit or a start took, in the Mac's log (Console, category
    /// "session"): the steps' names and milliseconds only.
    struct Steps {
        let what: String
        var at = Date(), begun = Date(), parts: [String] = []
        init(_ what: String) { self.what = what }
        mutating func mark(_ step: String) { let now = Date(); parts.append("\(step) \(Int(now.timeIntervalSince(at) * 1000))"); at = now }
        func done() { Session.log.notice("\(what, privacy: .public): \(parts.joined(separator: ", "), privacy: .public); \(Int(Date().timeIntervalSince(begun) * 1000), privacy: .public) ms in all") }
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

    /// The most a picture may hold: what 3840 × 2160 does. Displays stacked one above the
    /// other make a tall "all displays" that the width limit alone leaves at twice that,
    /// and a phone's page crashed on it.
    static let maxPicturePixels: CGFloat = 3840 * 2160
    /// "All displays" holds what one large display sends, not several together: at three
    /// times the pixels it moved in jerks where a single display was smooth.
    /// Zooming shows each display a little softer; a single one is sharper.
    static let allDisplaysPixels: CGFloat = 2560 * 1440

    /// The picture's size in even pixels: within maxWidth and the pixels allowed, its shape kept.
    static func pictureSize(width: CGFloat, height: CGFloat, maxWidth: Int, maxPixels: CGFloat = maxPicturePixels) -> (width: Int, height: Int) {
        var w = width, h = height
        if w > CGFloat(maxWidth) { h = h * CGFloat(maxWidth) / w; w = CGFloat(maxWidth) }
        let over = w * h / maxPixels
        if over > 1 { w /= over.squareRoot(); h /= over.squareRoot() }
        return (max(64, Int(w) & ~1), max(64, Int(h) & ~1))
    }

    private func start(kind: String, id: Int, maxWidth: Int, fps: Int, bitrate: Int, hevc: Bool, cursor: Bool = true) async {
        // Another window or a display shown: the one made the device's shape goes back.
        var steps = Steps("start")
        defer { steps.done() }
        if let f = fitted, kind != "window" || Int(f.id) != id { await unfit() }
        steps.mark("unfit")
        await stop()
        steps.mark("stop")
        let woke = await Self.wakeDisplays()
        steps.mark("wake (\(woke))")
        lastStart = (kind, id, maxWidth, fps, bitrate, hevc);lastCursor = cursor
        displaysAtStart = Self.displaysSignature()
        do {
            let found0 = try await Catalog.target(kind: kind, id: id)
            steps.mark("list")
            guard let found = found0 else {
                link.send(json: ["t": "error", "where": "start", "message": "gone"]); return
            }
            // Pixels, not points: a Retina display's full detail, scaled down to fit maxWidth.
            let backing = await MainActor.run { NSScreen.main?.backingScaleFactor ?? 2 }
            // A display's own mode says it: CGDisplayPixelsWide gives points, which left a whole
            // screen at half the detail of its windows.
            let mode = kind == "display" && id != Catalog.allDisplays ? CGDisplayCopyDisplayMode(CGDirectDisplayID(id)) : nil
            let scale = mode.map { CGFloat($0.pixelWidth) / max(1, CGFloat($0.width)) } ?? backing
            let w = found.size.width * max(1, scale), h = found.size.height * max(1, scale)
            guard w.isFinite, h.isFinite else { link.send(json: ["t": "error", "where": "start", "message": "gone"]); return }
            let (width, height) = Self.pictureSize(width: w, height: h, maxWidth: maxWidth, maxPixels: found.parts.isEmpty ? Self.maxPicturePixels : Self.allDisplaysPixels)
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
            steps.mark("encoder")
            target = found
            windowFrame = nil
            frameCheckedAt = 0
            if found.windowID == nil { await restore() }
            if let pid = found.pid, let wid = found.windowID {
                await note(wid, pid: pid)
                Catalog.bringForward(wid, pid: pid)
                // On another desktop or in the Dock: wait for macOS to bring it here.
                if !found.here { for _ in 0..<20 where !Catalog.isHere(wid) { try? await Task.sleep(nanoseconds: 100_000_000) } }
            }
            steps.mark("forward (window \(Int(found.size.width))x\(Int(found.size.height)))")
            // On the screen now: its app's alerts, sheets and menus over it are in the picture
            // too, the cut following the window (the window alone when it cannot be so).
            var shown = found
            if let pid = found.pid, let wid = found.windowID, pid != ProcessInfo.processInfo.processIdentifier,
               let withApp = await Catalog.withItsApp(wid, pid: pid) { shown = withApp }
            steps.mark("with app")
            try await capture.start(shown, width: width, height: height, fps: fps, cursor: cursor)
            steps.mark("capture")
            if let wid = shown.windowID { followCut(wid, display: shown.display, cut: shown.crop != nil) }
            link.send(json: ["t": "started", "kind": kind, "id": id, "width": width, "height": height, "fps": fps])
            // Whether a text field already has the focus, so the page knows where it starts.
            link.send(json: ["t": "focus", "editable": input.focusEditable(), "initial": true])
            steps.mark("focus")
        } catch {
            link.send(json: ["t": "error", "where": "start", "message": error.localizedDescription])
        }
    }

    /// Makes a window the device's shape, putting back one made so before. The page starts
    /// the window's picture again at its new size.
    private func fit(_ id: CGWindowID, _ size: CGSize) async {
        var steps = Steps("fit")
        defer { steps.done() }
        if let f = fitted, f.id != id { await unfit() }
        steps.mark("unfit")
        let link = self.link
        let content = try? await Catalog.content()
        steps.mark("list")
        guard let pid = content?.windows.first(where: { $0.windowID == id })?.owningApplication?.processID,
              pid != ProcessInfo.processInfo.processIdentifier else {
            link.send(json: ["t": "fitted", "id": Int(id), "ok": false]); return
        }
        let again = fitted?.id == id ? fitted : nil
        // Brought to the front first, out of full screen and onto the desktop shown: a window
        // left on another desktop or in full screen was never shown (Connecting…). Put back as
        // it was, full screen too, when another app is opened or the page leaves.
        let fullNow = await MainActor.run { Fit.axWindow(id, pid: pid).map(Fit.isFullScreen) ?? false }
        var wasFull = again?.fullScreen ?? fullNow
        if wasFull && again == nil {
            await MainActor.run { if let w = Fit.axWindow(id, pid: pid) { Fit.setFullScreen(w, false) } }
            for _ in 0..<30 {
                try? await Task.sleep(nanoseconds: 100_000_000)
                if await MainActor.run(body: { Fit.axWindow(id, pid: pid).map(Fit.isFullScreen) ?? false }) == false { break }
            }
            try? await Task.sleep(nanoseconds: 400_000_000)
        }
        steps.mark("full screen")
        await note(id, pid: pid)
        steps.mark("note")
        await bringHere(id, pid: pid)
        steps.mark("bring here")
        // Full screen on another desktop could not be seen from here (Accessibility lists only
        // the windows on the desktop shown): out of it now that it is here, and brought here again.
        let fullHere = await MainActor.run(body: { Fit.axWindow(id, pid: pid).map(Fit.isFullScreen) ?? false })
        steps.mark(fullHere ? "full screen here" : "not full screen")
        if fullHere {
            if again == nil { wasFull = true }
            await MainActor.run { if let w = Fit.axWindow(id, pid: pid) { Fit.setFullScreen(w, false) } }
            for _ in 0..<30 {
                try? await Task.sleep(nanoseconds: 100_000_000)
                if await MainActor.run(body: { Fit.axWindow(id, pid: pid).map(Fit.isFullScreen) ?? false }) == false { break }
            }
            try? await Task.sleep(nanoseconds: 400_000_000)
            await bringHere(id, pid: pid)
            steps.mark("out of full screen")
        }
        let result: (CGRect, CGRect)? = await MainActor.run {
            guard let w = Fit.axWindow(id, pid: pid), let now = Fit.frame(w) else { return nil }
            Fit.set(w, Fit.place(size, from: now, in: Fit.usable(for: now)))
            return (again?.was ?? now, Fit.frame(w) ?? now)
        }
        steps.mark("resize (asked \(Int(size.width))x\(Int(size.height)), " + (result.map { "\(Int($0.1.width))x\(Int($0.1.height))" } ?? "no window") + ")")
        guard let (before, after) = result else { link.send(json: ["t": "fitted", "id": Int(id), "ok": false]); return }
        fitted = (id, pid, before, wasFull)
        windowFrame = nil; frameCheckedAt = 0
        link.send(json: ["t": "fitted", "id": Int(id), "ok": true, "width": Int(after.width), "height": Int(after.height)])
    }

    /// Brought to the front and waited for until Accessibility can reach it: switching to
    /// another desktop takes the Mac a few seconds, and a window still on its way was not
    /// found, so it was left at its own size the first time (fine the next, already here).
    private func bringHere(_ id: CGWindowID, pid: pid_t) async {
        Catalog.bringForward(id, pid: pid)
        for _ in 0..<45 {
            if Catalog.isHere(id), await MainActor.run(body: { Fit.axWindow(id, pid: pid) != nil }) { return }
            try? await Task.sleep(nanoseconds: 100_000_000)
        }
        Self.log.error("window \(id) not reachable 4.5 s after bringing it forward")
    }

    /// Closes a window on the Mac (the switcher's swipe up); the list follows.
    private func close(_ id: CGWindowID) async {
        if fitted?.id == id { fitted = nil }
        guard let pid = (try? await Catalog.content())?.windows.first(where: { $0.windowID == id })?.owningApplication?.processID,
              pid != ProcessInfo.processInfo.processIdentifier else { return }
        await MainActor.run { if let w = Fit.axWindow(id, pid: pid) { Fit.close(w) } }
        try? await Task.sleep(nanoseconds: 300_000_000)
        route(.list)
    }

    /// Puts a window in the Dock (the yellow button); the list follows.
    private func minimize(_ id: CGWindowID) async {
        if fitted?.id == id { await unfit() }
        guard let pid = (try? await Catalog.content())?.windows.first(where: { $0.windowID == id })?.owningApplication?.processID,
              pid != ProcessInfo.processInfo.processIdentifier else { return }
        // A window in full screen (one put back there by unfit) cannot go in the Dock: macOS
        // ignores it, and the list that follows shows it where it is.
        await MainActor.run { if let w = Fit.axWindow(id, pid: pid), !Fit.isFullScreen(w) { Fit.minimize(w) } }
        // The window is out of the list until its slide into the Dock ends (measured: gone
        // at half a second, there and marked at one).
        try? await Task.sleep(nanoseconds: 1_200_000_000)
        route(.list)
    }

    /// Puts the window made the device's shape back where and as large as it was.
    private func unfit() async {
        guard let f = fitted else { return }
        fitted = nil
        await MainActor.run {
            guard let w = Fit.axWindow(f.id, pid: f.pid) else { return }
            Fit.set(w, f.was)
            if f.fullScreen { Fit.setFullScreen(w, true) }
        }
        windowFrame = nil; frameCheckedAt = 0
    }

    /// Before a window is brought forward: the app in front now (kept from the first one),
    /// and how this window was out of sight, if it was. One brought forward before and
    /// now left for another goes back first.
    private func note(_ id: CGWindowID, pid: pid_t) async {
        if let a = away, a.id != id { await putAway() }
        let me = ProcessInfo.processInfo.processIdentifier
        let front = await MainActor.run { NSWorkspace.shared.frontmostApplication?.processIdentifier }
        if inFront == nil, let front, front != me { inFront = front }
        guard away?.id != id, !Catalog.isHere(id) else { return }
        let how: Away? = await MainActor.run {
            if NSRunningApplication(processIdentifier: pid)?.isHidden == true { return .hidden }
            if let w = Fit.axWindow(id, pid: pid), Fit.isMinimized(w) { return .minimized }
            // Not on the screen though its desktop is one shown: closed, its app still running.
            if let space = Spaces.of(id), Spaces.desks()[space]?.current == true { return .closed }
            return nil
        }
        if let how { away = (id, pid, how) }
    }

    /// The window brought forward goes back out of sight as it was: its app hidden again
    /// (for a closed one too: closing it might lose its work), or into the Dock.
    private func putAway() async {
        guard let a = away else { return }
        away = nil
        await MainActor.run {
            switch a.how {
            case .minimized: if let w = Fit.axWindow(a.id, pid: a.pid) { Fit.minimize(w) }
            case .hidden, .closed: _ = NSRunningApplication(processIdentifier: a.pid)?.hide()
            }
        }
    }

    /// As it was before the viewer: the window out of sight again, and the app that was in
    /// front back in front, which takes the Mac back to its desktop (not when it is the
    /// window's own app, which that would show again).
    private func restore() async {
        let pid = inFront, hid = away?.pid
        inFront = nil
        await putAway()
        if let pid, pid != hid { Catalog.activate(pid) }
    }

    /// The cut picture of a window kept on it as it moves or changes size, twice a second,
    /// within its display (`display`, global points).
    private var lastCursor = true
    private var following: Task<Void, Never>?
    /// Taken partly off its display or to another one: the picture started again, cut anew or
    /// of the window alone (Catalog.withItsApp). Stopped with the picture.
    /// A window closed (its last tab, say) ends its picture: a cut one is of its app, which
    /// goes on running, and would keep showing the window's last frame.
    private func followCut(_ wid: CGWindowID, display: CGRect, cut: Bool) {
        following?.cancel()
        let capture = self.capture
        following = Task.detached { [weak self] in
            var last: CGRect?, missed = 0
            while !Task.isCancelled {
                try? await Task.sleep(nanoseconds: 500_000_000)
                guard !Task.isCancelled else { return }
                // Gone from the window server, twice running (not a moment's slip): closed.
                guard let f = Catalog.frame(of: wid) else {
                    missed += 1
                    if missed >= 2 { await self?.windowClosed(wid);return }
                    continue
                }
                missed = 0
                if !cut || f == last { continue }
                // Out of sight (another desktop, the Dock): left as it is until it is back, not
                // brought back here by starting again.
                if !Catalog.isHere(wid) { last = nil;continue }
                last = f
                if !display.contains(f) { await self?.restartCut(wid);return }
                if !(await capture.follow(f.offsetBy(dx: -display.minX, dy: -display.minY))) { return }
            }
        }
    }
    private func windowClosed(_ wid: CGWindowID) async {
        guard target?.windowID == wid else { return }
        if fitted?.id == wid { fitted = nil }
        await stop()
        link.send(json: ["t": "stopped", "reason": "the window was closed", "closed": true])
    }
    private func restartCut(_ wid: CGWindowID) async {
        guard target?.windowID == wid, let s = lastStart, s.kind == "window", s.id == Int(wid) else { return }
        await start(kind: s.kind, id: s.id, maxWidth: s.maxWidth, fps: s.fps, bitrate: s.bitrate, hevc: s.hevc, cursor: lastCursor)
    }

    func stop() async {
        following?.cancel();following = nil
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
