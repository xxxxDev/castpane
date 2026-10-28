import Foundation
import os

/// The capture core, in the app's own process: listens on host.sock for the castpane
/// server and serves one viewer at a time. Screen Recording and Accessibility are then
/// asked for Castpane.app alone, never for node.
///
/// Its state (the listener, the viewer, the connections waiting for their hello) is
/// behind `lock`; it is started and stopped from the app's main thread and from the
/// threads that accept and read connections.
public final class HostServer: @unchecked Sendable {
    private static let versionValue = OSAllocatedUnfairLock(initialState: "0.1.2")
    /// The version the status message reports. Set once at launch.
    public static var version: String {
        get { versionValue.withLock { $0 } }
        set { versionValue.withLock { $0 = newValue } }
    }

    private let socketPath: String
    private var token: String
    private var listener: Listener?
    /// The viewer: the connection whose hello was good, and only that one.
    private var current: Link?
    /// Connections still waiting for their hello.
    private var waiting: [ObjectIdentifier: Link] = [:]
    private let lock = NSLock()

    private var viewerChange: (@MainActor @Sendable (Bool) -> Void)?
    /// Called on the main queue when a viewer connects (true) or goes (false).
    public var onViewerChange: (@MainActor @Sendable (Bool) -> Void)? {
        get { lock.withLock { viewerChange } }
        set { lock.withLock { viewerChange = newValue } }
    }

    /// How long a new connection has to send a valid hello before it is closed.
    let helloTimeout: TimeInterval

    public init(socketPath: String, token: String, helloTimeout: TimeInterval = 5) {
        self.socketPath = socketPath
        self.token = token
        self.helloTimeout = helloTimeout
    }

    public var isListening: Bool { lock.withLock { listener != nil } }
    public var hasViewer: Bool { lock.withLock { current != nil } }

    /// Starts listening (again). The token may have changed since the last start.
    public func start(token: String? = nil) throws {
        lock.lock()
        if let token { self.token = token }
        let running = listener != nil
        lock.unlock()
        if running { return }
        let l = Listener(path: socketPath)
        try l.start { [weak self] fd in self?.accept(fd) }
        lock.withLock { listener = l }
    }

    /// Stops listening and ends the viewer. Their buttons and keys are let go of.
    public func stop() {
        let l = lock.withLock { () -> Listener? in defer { listener = nil }; return listener }
        l?.stop()
        closeAll()
    }

    /// Ends the current viewer's connection, if any; the listener stays.
    public func disconnect() {
        let link = lock.withLock { current }
        link?.close()
    }

    /// Ends the viewer and every connection that has not said hello yet.
    private func closeAll() {
        let links = lock.withLock { () -> [Link] in Array(waiting.values) + (current.map { [$0] } ?? []) }
        for l in links { l.close() }
    }

    /// A new connection is nobody yet: it replaces the viewer, and counts as one, only
    /// once its hello carried the token. Until then it can be closed, and is after
    /// `helloTimeout`, without touching the connection that is current.
    private func accept(_ fd: Int32) {
        let link = Link(fd: fd)
        let token = lock.withLock { self.token }
        let session = Session(link: link, token: token) { [weak self] in self?.promote(link) ?? false }
        session.begin()
        link.onClose = { [weak self] in
            session.end()
            guard let self else { return }
            let gone = self.lock.withLock { () -> Bool in
                self.waiting[ObjectIdentifier(link)] = nil
                if self.current === link { self.current = nil; return true }
                return false
            }
            if gone { self.notify(false) }
        }
        lock.withLock { waiting[ObjectIdentifier(link)] = link }
        DispatchQueue.global().asyncAfter(deadline: .now() + helloTimeout) {
            if !session.isTrusted { link.close() }
        }
        Thread.detachNewThread { link.readLoop { kind, data in session.handle(kind, data) } }
    }

    /// The hello was good: this connection is the viewer now. One at a time, so the one
    /// before it ends.
    private func promote(_ link: Link) -> Bool {
        let previous = lock.withLock { () -> Link?? in
            waiting[ObjectIdentifier(link)] = nil
            // Closed while its hello was handled, or sharing stopped meanwhile: it never
            // becomes the viewer.
            guard !link.isClosed, listener != nil else { return .none }
            let p = current
            current = link
            return .some(p)
        }
        guard let previous else { return false }
        previous?.close()
        notify(true)
        return true
    }

    private func notify(_ connected: Bool) {
        guard let handler = onViewerChange else { return }
        DispatchQueue.main.async { MainActor.assumeIsolated { handler(connected) } }
    }
}
