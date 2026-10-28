import AppKit

/// The Mac's clipboard as text, read and written for the viewer (the owner's request,
/// 2026-10-29). What a password manager marks as concealed or transient
/// (nspasteboard.org) is never handed out.
public enum Clipboard {
    /// The most text either way, in UTF-16 units.
    static let maxLength = 100_000
    static let hidden: Set<String> = ["org.nspasteboard.ConcealedType", "org.nspasteboard.TransientType"]

    enum Read: Equatable { case text(String, truncated: Bool), empty, concealed, notAllowed, denied }

    /// Whether reading the clipboard would ask on the Mac first (macOS 15.4 and later, until
    /// the owner sets Castpane to Allow in System Settings › Privacy & Security › Paste from
    /// Other Apps): nil where the system does not ask.
    public enum Access: Equatable, Sendable { case notAsked, ask, allowed, denied }
    @MainActor public static var access: Access? {
        guard #available(macOS 15.4, *) else { return nil }
        switch NSPasteboard.general.accessBehavior {
        case .alwaysAllow: return .allowed
        case .alwaysDeny: return .denied
        case .ask: return .ask
        default: return .notAsked
        }
    }

    @MainActor static func read(_ board: NSPasteboard = .general) -> Read {
        // No one may be at the Mac to answer the system's question: not read until allowed.
        if board.name == .general, let access {
            if access == .denied { return .denied }
            if access != .allowed { return .notAllowed }
        }
        let before = board.changeCount
        if (board.types ?? []).contains(where: { hidden.contains($0.rawValue) }) { return .concealed }
        guard let s = board.string(forType: .string), !s.isEmpty else { return .empty }
        // Something copied in between (perhaps a password) is not sent.
        guard board.changeCount == before else { return .concealed }
        // Through UTF-8, so a lone surrogate becomes U+FFFD and the text is valid JSON.
        return cut(String(decoding: Array(s.utf8), as: UTF8.self))
    }

    /// Asks on the Mac once, so Castpane appears in System Settings › Paste from Other Apps.
    @MainActor public static func askOnce() { _ = NSPasteboard.general.string(forType: .string) }

    /// `s` up to `maxLength` UTF-16 units, cut between whole characters.
    static func cut(_ s: String, max: Int = maxLength) -> Read {
        guard s.utf16.count > max else { return .text(s, truncated: false) }
        var units = 0, end = s.startIndex
        for i in s.indices {
            let n = s[i].utf16.count
            if units + n > max { break }
            units += n; end = s.index(after: i)
        }
        return .text(String(s[..<end]), truncated: true)
    }

    @MainActor static func write(_ s: String, _ board: NSPasteboard = .general) {
        board.clearContents()
        board.setString(s, forType: .string)
    }
}
