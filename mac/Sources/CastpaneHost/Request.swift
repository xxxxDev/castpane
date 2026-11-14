import Foundation

// The page's requests, read once from the JSON the server relays and checked field by
// field. Every number from the page passes `Field`: a value that is not a finite number
// (a string, a Bool, NaN, ±infinity, 1e300 for a whole number) makes the request invalid
// instead of reaching an Int conversion that would stop the app.

enum Field {
    /// A finite number, or nil: missing, not a number, a JSON true/false, NaN or ±infinity.
    static func number(_ v: Any?) -> Double? {
        guard let n = v as? NSNumber, CFGetTypeID(n) != CFBooleanGetTypeID() else { return nil }
        let d = n.doubleValue
        return d.isFinite ? d : nil
    }

    /// A whole number inside `range`, exactly as sent (no rounding, no clamping): for ids.
    static func exactInt(_ v: Any?, in range: ClosedRange<Int>) -> Int? {
        guard let d = number(v), let i = Int(exactly: d), range.contains(i) else { return nil }
        return i
    }

    /// A finite number brought into `range` while still a Double, then made whole. Missing
    /// gives `fallback`; present but not a finite number gives nil.
    static func clampedInt(_ v: Any?, _ range: ClosedRange<Int>, default fallback: Int) -> Int? {
        if v == nil || v is NSNull { return fallback }
        guard let d = number(v) else { return nil }
        return Int(max(Double(range.lowerBound), min(Double(range.upperBound), d.rounded(.towardZero))))
    }
}

enum Request: Equatable, Sendable {
    case status, permissions, list, stop, ack, keyFrame
    case start(kind: String, id: Int, maxWidth: Int, fps: Int, bitrate: Int, hevc: Bool = false)
    case move(x: Double, y: Double)
    case button(Int, down: Bool, x: Double, y: Double)
    case probe(x: Double, y: Double, n: Double)
    case scroll(dx: Double, dy: Double, x: Double, y: Double)
    case key(code: String, down: Bool, mods: [String])
    case text(String)
    case clipboardGet
    case clipboardSet(String)
    case apps
    case icons([String])
    case launch(String)
    /// A window made `width` × `height` points (the device's shape); `unfit` puts it back.
    case fit(id: Int, width: Int, height: Int)
    case unfit
    /// A window closed on the Mac, as its close button would (the switcher's swipe up).
    case close(id: Int)
    /// The Mac's password typed into its lock screen; never kept or logged.
    case unlock(String)
    /// A known request with a field out of shape; `t` is what it was, for an error answer.
    case invalid(String)

    /// Display and window ids are 32-bit (CGDirectDisplayID, CGWindowID).
    static let ids = 0...Int(UInt32.max)

    /// The request in `msg`, `.invalid` when a field is wrong, nil for an unknown `t`.
    static func parse(_ msg: [String: Any]) -> Request? {
        guard let t = msg["t"] as? String else { return nil }
        func point() -> (Double, Double)? {
            guard let x = Field.number(msg["x"]), let y = Field.number(msg["y"]) else { return nil }
            return (x, y)
        }
        switch t {
        case "status": return .status
        case "permissions": return .permissions
        case "list": return .list
        case "stop": return .stop
        case "ack": return .ack
        case "key-frame": return .keyFrame
        case "clipboard-get": return .clipboardGet
        case "clipboard-set":
            guard let s = msg["s"] as? String, !s.isEmpty, s.utf16.count <= Clipboard.maxLength else { return .invalid(t) }
            return .clipboardSet(s)
        case "apps": return .apps
        case "unfit": return .unfit
        case "close":
            guard let id = Field.exactInt(msg["id"], in: ids) else { return .invalid(t) }
            return .close(id: id)
        case "icons":
            guard let list = msg["bundles"] as? [Any], list.count <= 40 else { return .invalid(t) }
            let bundles = list.compactMap { $0 as? String }.filter { $0.utf8.count <= 200 }
            return .icons(bundles)
        case "launch":
            guard let b = msg["bundle"] as? String, b.utf8.count <= 200, !b.isEmpty,
                  b.allSatisfy({ $0.isASCII && ($0.isLetter || $0.isNumber || $0 == "." || $0 == "-" || $0 == "_") }) else { return .invalid(t) }
            return .launch(b)
        case "fit":
            guard let id = Field.exactInt(msg["id"], in: ids), let w = Field.clampedInt(msg["width"], 240...8000, default: 0),
                  let h = Field.clampedInt(msg["height"], 240...8000, default: 0), w > 0, h > 0 else { return .invalid(t) }
            return .fit(id: id, width: w, height: h)
        case "start":
            guard let kind = msg["kind"] as? String, kind == "display" || kind == "window",
                  let id = Field.exactInt(msg["id"], in: ids),
                  let maxWidth = Field.clampedInt(msg["maxWidth"], 320...3840, default: 1920),
                  let fps = Field.clampedInt(msg["fps"], 10...60, default: 60),
                  let bitrate = Field.clampedInt(msg["bitrate"], 500_000...40_000_000, default: 8_000_000),
                  msg["codec"] == nil || msg["codec"] as? String == "h264" || msg["codec"] as? String == "hevc"
            else { return .invalid(t) }
            return .start(kind: kind, id: id, maxWidth: maxWidth, fps: fps, bitrate: bitrate, hevc: msg["codec"] as? String == "hevc")
        case "move":
            guard let (x, y) = point() else { return .invalid(t) }
            return .move(x: x, y: y)
        case "button":
            guard let (x, y) = point(), let b = Field.exactInt(msg["b"], in: 0...2), let down = msg["down"] as? Bool else { return .invalid(t) }
            return .button(b, down: down, x: x, y: y)
        case "probe":
            guard let (x, y) = point() else { return .invalid(t) }
            // `n` only comes back in the answer; anything but a finite number answers 0.
            return .probe(x: x, y: y, n: Field.number(msg["n"]) ?? 0)
        case "scroll":
            guard let (x, y) = point() else { return .invalid(t) }
            let dx = msg["dx"] == nil ? 0 : Field.number(msg["dx"]), dy = msg["dy"] == nil ? 0 : Field.number(msg["dy"])
            guard let dx, let dy else { return .invalid(t) }
            return .scroll(dx: dx, dy: dy, x: x, y: y)
        case "key":
            guard let code = msg["code"] as? String, code.utf8.count <= 64, let down = msg["down"] as? Bool else { return .invalid(t) }
            let mods = (msg["mods"] as? [Any] ?? []).compactMap { $0 as? String }
            return .key(code: code, down: down, mods: mods)
        case "unlock":
            guard let s = msg["s"] as? String, (1...256).contains(s.count) else { return .invalid(t) }
            return .unlock(s)
        case "text":
            guard let s = msg["s"] as? String, s.count <= 4000 else { return .invalid(t) }
            return .text(s)
        default:
            return nil
        }
    }
}
