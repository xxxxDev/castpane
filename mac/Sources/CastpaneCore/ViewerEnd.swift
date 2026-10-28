import Foundation

/// The order "Stop sharing now" and Pause end a viewer in: the server first ends their
/// pass and signs out the sign-in they watched from (POST /api/local/end-viewer), then the
/// capture core lets them go. The other way round, the core's close could reach the server
/// before the request and leave the pass and the sign-in as they were. A server that does
/// not answer holds the stop up for `timeout` at most.
public enum ViewerEnd {
    public static let defaultTimeout: Duration = .seconds(2)

    /// Runs `end`, waits for it at most `timeout`, then runs `stop`. Returns whether `end`
    /// finished in time.
    @MainActor @discardableResult
    public static func endThenStop(timeout: Duration = defaultTimeout,
                                   end: @escaping @Sendable () async -> Void,
                                   stop: () -> Void) async -> Bool {
        let inTime = await waitAtMost(timeout, end)
        stop()
        return inTime
    }

    /// Whether `operation` finished within `timeout`. It is not cancelled when it does
    /// not: it carries on by itself.
    public static func waitAtMost(_ timeout: Duration, _ operation: @escaping @Sendable () async -> Void) async -> Bool {
        let once = Once()
        return await withCheckedContinuation { (done: CheckedContinuation<Bool, Never>) in
            let timer = Task {
                try? await Task.sleep(for: timeout)
                if once.claim() { done.resume(returning: false) }
            }
            Task {
                await operation()
                if once.claim() { done.resume(returning: true); timer.cancel() }
            }
        }
    }
}

/// True for the first caller only.
private final class Once: @unchecked Sendable {
    private let lock = NSLock()
    private var claimed = false
    func claim() -> Bool { lock.withLock { defer { claimed = true }; return !claimed } }
}
