import AppKit

/// The Mac's clipboard as text, read and written for the viewer (the owner's request,
/// 2026-10-29). What a password manager marks as concealed or transient
/// (nspasteboard.org) is never handed out.
enum Clipboard {
    /// The most text either way, in UTF-16 units.
    static let maxLength = 100_000
    static let hidden: Set<String> = ["org.nspasteboard.ConcealedType", "org.nspasteboard.TransientType"]

    enum Read: Equatable { case text(String, truncated: Bool), empty, concealed }

    @MainActor static func read(_ board: NSPasteboard = .general) -> Read {
        if (board.types ?? []).contains(where: { hidden.contains($0.rawValue) }) { return .concealed }
        guard let s = board.string(forType: .string), !s.isEmpty else { return .empty }
        return cut(s)
    }

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
