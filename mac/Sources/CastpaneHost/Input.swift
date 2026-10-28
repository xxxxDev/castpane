import Foundation
import CoreGraphics
import ApplicationServices
import AppKit

// The page's clicks, scrolls and keys, posted as the Mac's own mouse and keyboard
// events (this needs Accessibility). Pointer positions arrive as 0…1 across the
// picture and are placed on the display or window being shown.
final class Input {
    private let source = CGEventSource(stateID: .hidSystemState)
    private var buttonsDown: Set<Int> = []
    private var keysDown: Set<CGKeyCode> = []
    private var lastClick: (time: TimeInterval, button: Int, point: CGPoint, count: Int64) = (0, -1, .zero, 0)
    private var flags: CGEventFlags = []
    private var scrollRest = CGPoint.zero

    func point(_ x: Double, _ y: Double, in rect: CGRect) -> CGPoint {
        CGPoint(x: rect.minX + max(0, min(1, x)) * rect.width, y: rect.minY + max(0, min(1, y)) * rect.height)
    }

    func move(to p: CGPoint) {
        let type: CGEventType = buttonsDown.contains(0) ? .leftMouseDragged : buttonsDown.contains(1) ? .rightMouseDragged : .mouseMoved
        let button: CGMouseButton = buttonsDown.contains(1) ? .right : .left
        post(CGEvent(mouseEventSource: source, mouseType: type, mouseCursorPosition: p, mouseButton: button))
    }

    func button(_ b: Int, down: Bool, at p: CGPoint) {
        let button: CGMouseButton = b == 1 ? .right : b == 2 ? .center : .left
        let type: CGEventType = b == 1 ? (down ? .rightMouseDown : .rightMouseUp)
            : b == 2 ? (down ? .otherMouseDown : .otherMouseUp) : (down ? .leftMouseDown : .leftMouseUp)
        if down {
            let now = ProcessInfo.processInfo.systemUptime
            let near = hypot(p.x - lastClick.point.x, p.y - lastClick.point.y) < 6
            let count: Int64 = (now - lastClick.time < NSEvent.doubleClickInterval && lastClick.button == b && near) ? min(lastClick.count + 1, 3) : 1
            lastClick = (now, b, p, count)
            buttonsDown.insert(b)
        } else {
            buttonsDown.remove(b)
        }
        guard let e = CGEvent(mouseEventSource: source, mouseType: type, mouseCursorPosition: p, mouseButton: button) else { return }
        e.setIntegerValueField(.mouseEventClickState, value: lastClick.count)
        e.flags = flags
        post(e)
    }

    func scroll(dx: Double, dy: Double, at p: CGPoint) {
        move(to: p)
        // Whole pixels go out; the fractions are kept for the next scroll, so a slow drag
        // (many moves of under a pixel) still scrolls.
        let x = max(-2000, min(2000, -dx + scrollRest.x)), y = max(-2000, min(2000, -dy + scrollRest.y))
        let wx = Int32(x.rounded(.towardZero)), wy = Int32(y.rounded(.towardZero))
        scrollRest = CGPoint(x: x - Double(wx), y: y - Double(wy))
        guard wx != 0 || wy != 0 else { return }
        guard let e = CGEvent(scrollWheelEvent2Source: source, units: .pixel, wheelCount: 2,
                              wheel1: wy, wheel2: wx, wheel3: 0) else { return }
        e.setIntegerValueField(.scrollWheelEventIsContinuous, value: 1)
        post(e)
    }

    /// A key by the browser's KeyboardEvent.code, with the modifiers held.
    func key(code: String, down: Bool, mods: [String]) {
        var f: CGEventFlags = []
        if mods.contains("shift") { f.insert(.maskShift) }
        if mods.contains("ctrl") { f.insert(.maskControl) }
        if mods.contains("alt") { f.insert(.maskAlternate) }
        if mods.contains("meta") { f.insert(.maskCommand) }
        flags = f
        guard let vk = Keys.map[code], let e = CGEvent(keyboardEventSource: source, virtualKey: vk, keyDown: down) else { return }
        if down { keysDown.insert(vk) } else { keysDown.remove(vk) }
        e.flags = f
        post(e)
    }

    /// Text typed or composed on the device (an input method's choice, dictation).
    func type(_ text: String) {
        for chunk in text.chunked(16) {
            let units = Array(chunk.utf16)
            for down in [true, false] {
                guard let e = CGEvent(keyboardEventSource: source, virtualKey: 0, keyDown: down) else { continue }
                e.keyboardSetUnicodeString(stringLength: units.count, unicodeString: units)
                e.flags = []
                post(e)
            }
        }
    }

    /// Whether the thing at this point takes typing: a text field, text area, search or
    /// combo box, in an app or a web page (Accessibility's own roles).
    func editable(at p: CGPoint) -> Bool {
        let system = Self.systemWide()
        var element: AXUIElement?
        guard AXUIElementCopyElementAtPosition(system, Float(p.x), Float(p.y), &element) == .success, var e = element else { return false }
        // The point often answers with the text inside a field (web pages): its parents too.
        for _ in 0..<4 {
            if Self.isEditable(e) { return true }
            var parent: CFTypeRef?
            guard AXUIElementCopyAttributeValue(e, kAXParentAttribute as CFString, &parent) == .success, let parent else { return false }
            e = parent as! AXUIElement
        }
        return false
    }
    /// The system-wide element, asking the focused app for a second at most: a hung app
    /// must not stall the viewer's session.
    static func systemWide() -> AXUIElement {
        let system = AXUIElementCreateSystemWide()
        AXUIElementSetMessagingTimeout(system, 1)
        return system
    }
    /// Whether what has the keyboard focus now takes typing.
    func focusEditable() -> Bool {
        let system = Self.systemWide()
        var value: CFTypeRef?
        guard AXUIElementCopyAttributeValue(system, kAXFocusedUIElementAttribute as CFString, &value) == .success, let value else { return false }
        return Self.isEditable(value as! AXUIElement)
    }
    /// Where the text cursor is now, on screen (global, top-left): the bounds of the
    /// selection in the focused field, or the field itself when it does not say.
    func caret() -> CGRect? {
        let system = Self.systemWide()
        var value: CFTypeRef?
        guard AXUIElementCopyAttributeValue(system, kAXFocusedUIElementAttribute as CFString, &value) == .success, let value else { return nil }
        let field = value as! AXUIElement
        guard Self.isEditable(field) else { return nil }
        var range: CFTypeRef?
        if AXUIElementCopyAttributeValue(field, kAXSelectedTextRangeAttribute as CFString, &range) == .success, let range {
            var bounds: CFTypeRef?
            if AXUIElementCopyParameterizedAttributeValue(field, kAXBoundsForRangeParameterizedAttribute as CFString, range, &bounds) == .success,
               let bounds, CFGetTypeID(bounds) == AXValueGetTypeID() {
                var r = CGRect.zero
                if AXValueGetValue(bounds as! AXValue, .cgRect, &r), r.origin.x.isFinite, r.height > 0 { return r }
            }
        }
        var pos: CFTypeRef?, size: CFTypeRef?
        var p = CGPoint.zero, sz = CGSize.zero
        if AXUIElementCopyAttributeValue(field, kAXPositionAttribute as CFString, &pos) == .success, let pos,
           AXUIElementCopyAttributeValue(field, kAXSizeAttribute as CFString, &size) == .success, let size,
           AXValueGetValue(pos as! AXValue, .cgPoint, &p), AXValueGetValue(size as! AXValue, .cgSize, &sz) {
            return CGRect(origin: p, size: CGSize(width: min(sz.width, 40), height: sz.height))
        }
        return nil
    }

    private static let textRoles: Set<String> = ["AXTextField", "AXTextArea", "AXComboBox", "AXSearchField"]
    private static func isEditable(_ e: AXUIElement) -> Bool {
        var role: CFTypeRef?
        if AXUIElementCopyAttributeValue(e, kAXRoleAttribute as CFString, &role) == .success, let r = role as? String, textRoles.contains(r) { return true }
        var editable: CFTypeRef?
        if AXUIElementCopyAttributeValue(e, "AXEditable" as CFString, &editable) == .success, (editable as? Bool) == true { return true }
        return false
    }

    /// Lets go of every button and key, so a page that went away never leaves one held
    /// (a ⌘ left down would turn every later key into a shortcut).
    func releaseAll(at p: CGPoint?) {
        let where_ = p ?? CGEvent(source: nil)?.location ?? .zero
        for b in buttonsDown { button(b, down: false, at: where_) }
        for vk in keysDown {
            guard let e = CGEvent(keyboardEventSource: source, virtualKey: vk, keyDown: false) else { continue }
            e.flags = []
            post(e)
        }
        keysDown = []
        flags = []
    }

    private func post(_ e: CGEvent?) { e?.post(tap: .cghidEventTap) }
}

private extension String {
    func chunked(_ n: Int) -> [String] {
        var out: [String] = []
        var current = ""
        for ch in self {
            if current.utf16.count + String(ch).utf16.count > n { out.append(current); current = "" }
            current.append(ch)
        }
        if !current.isEmpty { out.append(current) }
        return out
    }
}

enum Keys {
    // KeyboardEvent.code → macOS virtual key code (US layout positions).
    static let map: [String: CGKeyCode] = [
        "KeyA": 0, "KeyS": 1, "KeyD": 2, "KeyF": 3, "KeyH": 4, "KeyG": 5, "KeyZ": 6, "KeyX": 7, "KeyC": 8, "KeyV": 9,
        "KeyB": 11, "KeyQ": 12, "KeyW": 13, "KeyE": 14, "KeyR": 15, "KeyY": 16, "KeyT": 17,
        "Digit1": 18, "Digit2": 19, "Digit3": 20, "Digit4": 21, "Digit6": 22, "Digit5": 23, "Equal": 24, "Digit9": 25,
        "Digit7": 26, "Minus": 27, "Digit8": 28, "Digit0": 29, "BracketRight": 30, "KeyO": 31, "KeyU": 32,
        "BracketLeft": 33, "KeyI": 34, "KeyP": 35, "Enter": 36, "KeyL": 37, "KeyJ": 38, "Quote": 39, "KeyK": 40,
        "Semicolon": 41, "Backslash": 42, "Comma": 43, "Slash": 44, "KeyN": 45, "KeyM": 46, "Period": 47,
        "Tab": 48, "Space": 49, "Backquote": 50, "Backspace": 51, "Escape": 53,
        "MetaRight": 54, "MetaLeft": 55, "ShiftLeft": 56, "CapsLock": 57, "AltLeft": 58, "ControlLeft": 59,
        "ShiftRight": 60, "AltRight": 61, "ControlRight": 62,
        "F5": 96, "F6": 97, "F7": 98, "F3": 99, "F8": 100, "F9": 101, "F11": 103, "F10": 109, "F12": 111,
        "Home": 115, "PageUp": 116, "Delete": 117, "F4": 118, "End": 119, "F2": 120, "PageDown": 121, "F1": 122,
        "ArrowLeft": 123, "ArrowRight": 124, "ArrowDown": 125, "ArrowUp": 126,
        "NumpadEnter": 76, "IntlBackslash": 10,
    ]
}
