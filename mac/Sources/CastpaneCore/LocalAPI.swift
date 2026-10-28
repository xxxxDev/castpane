import Foundation

/// The server's answers on /api/local/*, decoded leniently: a field the server leaves
/// out or shapes a little differently does not lose the rest.
public struct LocalStatus: Equatable, Sendable {
    public struct Viewer: Equatable, Sendable {
        public var username: String
        public var since: Date?
    }

    public var version: String = ""
    public var users: Int = 0
    public var admins: Int = 0
    public var viewer: Viewer?
    public var sessions: Int = 0
    public var publicOrigin: String = ""

    public init() {}

    public static func decode(_ data: Data) -> LocalStatus? {
        guard let obj = try? JSONSerialization.jsonObject(with: data) as? [String: Any] else { return nil }
        var s = LocalStatus()
        s.version = obj["version"] as? String ?? ""
        s.users = LocalJSON.count(obj["users"])
        s.admins = LocalJSON.count(obj["admins"])
        s.sessions = LocalJSON.count(obj["sessions"])
        s.publicOrigin = obj["publicOrigin"] as? String ?? ""
        if let v = obj["viewer"] as? [String: Any] {
            s.viewer = Viewer(username: v["username"] as? String ?? "", since: LocalJSON.date(v["since"]))
        }
        return s
    }
}

/// Whether this Mac joined another Mac's Castpane, and how its link is.
public struct MemberStatus: Equatable, Sendable {
    /// off, connecting, connected or removed.
    public var state: String = "off"
    public var hub: String = ""

    public init() {}

    public static func decode(_ data: Data) -> MemberStatus {
        var s = MemberStatus()
        guard let obj = try? JSONSerialization.jsonObject(with: data) as? [String: Any] else { return s }
        s.state = obj["state"] as? String ?? "off"
        s.hub = obj["hub"] as? String ?? ""
        return s
    }
}

/// One line of the activity list: a remote session opened or ended, or a sign-in.
public struct ActivityItem: Equatable, Identifiable, Sendable {
    public var id: Int
    public var at: Date?
    public var kind: String
    public var username: String
    public var detail: String
    /// The other Mac it was on, for a session through this one (docs/multi-mac.md).
    public var machine: String = ""
    /// How many times in a row, for a clipboard use.
    public var count: Int = 1

    /// `{items: [...]}` or a bare array; each item's time from `at`, `time` or `ts`.
    public static func decodeList(_ data: Data) -> [ActivityItem] {
        guard let obj = try? JSONSerialization.jsonObject(with: data) else { return [] }
        let rows = (obj as? [[String: Any]]) ?? ((obj as? [String: Any])?["items"] as? [[String: Any]]) ?? []
        return rows.enumerated().map { i, r in
            let kind = (r["type"] ?? r["event"] ?? r["action"] ?? r["kind"]) as? String ?? ""
            let user = (r["username"] ?? r["user"]) as? String ?? ""
            let parts = ["method", "ip", "from", "device", "detail", "reason"].compactMap { r[$0] as? String }.filter { !$0.isEmpty }
            return ActivityItem(id: i, at: LocalJSON.date(r["at"] ?? r["time"] ?? r["ts"]), kind: kind, username: user,
                                detail: parts.joined(separator: " · "), machine: r["machine"] as? String ?? "",
                                count: max(1, LocalJSON.count(r["count"])))
        }
    }
}

enum LocalJSON {
    /// A number, or the length of a list.
    static func count(_ v: Any?) -> Int {
        if let n = v as? NSNumber { return n.intValue }
        if let a = v as? [Any] { return a.count }
        return 0
    }

    /// Milliseconds or seconds since 1970, or an ISO 8601 string.
    static func date(_ v: Any?) -> Date? {
        if let n = v as? NSNumber {
            let x = n.doubleValue
            return Date(timeIntervalSince1970: x > 10_000_000_000 ? x / 1000 : x)
        }
        if let s = v as? String {
            let f = ISO8601DateFormatter()
            f.formatOptions = [.withInternetDateTime, .withFractionalSeconds]
            if let d = f.date(from: s) { return d }
            f.formatOptions = [.withInternetDateTime]
            return f.date(from: s)
        }
        return nil
    }
}

/// The server's error text in `{error: "…"}` or `{message: "…"}`, if it sent one.
public func localErrorMessage(_ data: Data) -> String? {
    guard let obj = try? JSONSerialization.jsonObject(with: data) as? [String: Any] else { return nil }
    return (obj["error"] ?? obj["message"]) as? String
}
