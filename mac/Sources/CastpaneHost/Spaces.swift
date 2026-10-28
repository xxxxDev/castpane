import Foundation
import CoreGraphics

// Which of the Mac's desktops (Spaces) each window is on. macOS has no public API for
// this; these are the window server's own calls, the ones window managers (yabai,
// Amethyst) use. If one stops answering in a later macOS, windows are simply listed
// without their desktop.
@_silgen_name("CGSMainConnectionID") private func CGSMainConnectionID() -> Int32
@_silgen_name("CGSCopyManagedDisplaySpaces") private func CGSCopyManagedDisplaySpaces(_ cid: Int32) -> Unmanaged<CFArray>?
@_silgen_name("CGSCopySpacesForWindows") private func CGSCopySpacesForWindows(_ cid: Int32, _ mask: Int32, _ wids: CFArray) -> Unmanaged<CFArray>?

enum Spaces {
    struct Desk { let id: Int; let number: Int; let display: Int; let fullscreen: Bool; let current: Bool }

    /// Every desktop, numbered per display as Mission Control numbers them (full-screen
    /// apps have spaces of their own and are not numbered).
    static func desks() -> [Int: Desk] {
        guard let list = CGSCopyManagedDisplaySpaces(CGSMainConnectionID())?.takeRetainedValue() as? [[String: Any]] else { return [:] }
        var out: [Int: Desk] = [:]
        for (d, display) in list.enumerated() {
            let current = ((display["Current Space"] as? [String: Any])?["ManagedSpaceID"] as? Int) ?? -1
            var n = 0
            for space in display["Spaces"] as? [[String: Any]] ?? [] {
                guard let id = space["ManagedSpaceID"] as? Int ?? space["id64"] as? Int else { continue }
                let full = (space["type"] as? Int) == 4
                if !full { n += 1 }
                out[id] = Desk(id: id, number: full ? 0 : n, display: d, fullscreen: full, current: id == current)
            }
        }
        return out
    }

    /// The desktop a window is on, if it is on one (a window in the Dock is on none).
    static func of(_ windowID: CGWindowID) -> Int? {
        let ids = [NSNumber(value: windowID)] as CFArray
        guard let spaces = CGSCopySpacesForWindows(CGSMainConnectionID(), 7, ids)?.takeRetainedValue() as? [Int] else { return nil }
        return spaces.first
    }
}
