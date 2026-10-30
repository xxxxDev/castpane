import CoreGraphics
import Foundation
import IOKit.pwr_mgt
import os

// A viewer reaching a Mac whose display has gone to sleep (or that sits at its lock
// screen, which turns the display off after a minute) got nothing: with the display
// asleep the screen capture lists no displays and sends no frames. Waking it the way a
// touch of the keyboard would brings the picture, the lock screen included, back; the
// password can then be typed from the page (the owner's report, 2026-10-30).
enum Wake {
    private static let assertion = OSAllocatedUnfairLock<IOPMAssertionID>(initialState: 0)

    /// Whether any display is asleep or the screen is locked now.
    static var needed: Bool {
        var ids = [CGDirectDisplayID](repeating: 0, count: 16), count: UInt32 = 0
        if CGGetOnlineDisplayList(16, &ids, &count) == .success, ids.prefix(Int(count)).contains(where: { CGDisplayIsAsleep($0) != 0 }) {
            return true
        }
        let session = CGSessionCopyCurrentDictionary() as? [String: Any]
        return session?["CGSSessionScreenIsLocked"] as? Bool ?? false
    }

    /// Wakes the displays as user activity does (and keeps them on as long as it would).
    static func display() {
        assertion.withLock { id in
            _ = IOPMAssertionDeclareUserActivity("Castpane has a viewer" as CFString, kIOPMUserActiveLocal, &id)
        }
    }
}
