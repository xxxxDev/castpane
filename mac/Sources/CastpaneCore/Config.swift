import Foundation

/// How phones reach this Mac. `none` until one is chosen: the server then serves this Mac
/// alone, at 127.0.0.1. A plain-HTTP local-network mode was dropped: browsers give the video
/// decoder and passkeys to secure pages only, so Remote could not work there.
public enum ConnectionMode: String, Codable, CaseIterable, Sendable {
    case none, quick, domain, tailscale

    /// The ones a person can choose; `none` turns the connection off again.
    public static let choices: [ConnectionMode] = [.none, .quick, .domain, .tailscale]

    public var title: String {
        switch self {
        case .none: return "Not connected"
        case .quick: return "Quick tunnel"
        case .domain: return "Your own domain"
        case .tailscale: return "Tailscale"
        }
    }

    /// Whether the app runs cloudflared for this mode.
    public var usesCloudflared: Bool { self == .quick || self == .domain }
}

/// config.json, which the app writes and the server reads. `port`, `publicOrigin`,
/// `connection` and `hostname` are the contract; the rest are the app's own settings,
/// kept in the same file so there is one place to look.
public struct AppConfig: Codable, Equatable, Sendable {
    public static let defaultPort = 47900

    public var port: Int = AppConfig.defaultPort
    /// The address phones open, without a trailing slash; empty for this Mac only.
    public var publicOrigin: String = ""
    /// An unknown value (such as the old `local`) loads as `none`.
    public var connection: ConnectionMode = .none
    /// The host name in the address (`remote.example.com`, …).
    public var hostname: String = ""
    /// Own domain: the host name the tunnel serves.
    public var domainHostname: String = ""
    /// Tailscale: the address as typed (normalized).
    public var tailscaleOrigin: String = ""
    /// The remote page's starting quality: auto, high, balanced or low.
    public var defaultQuality: String = "auto"
    public var keepAwake: Bool = true
    /// Sharing paused from the menu: the capture core is not listening.
    public var paused: Bool = false
    /// Look for a new release once a day.
    public var checkForUpdates: Bool = true
    /// Offer beta releases too (all of castpane's releases are betas for now).
    public var betaUpdates: Bool = true

    public init() {}

    public init(from decoder: Decoder) throws {
        // Every field optional: an older or hand-edited file still loads.
        let c = try decoder.container(keyedBy: CodingKeys.self)
        let d = AppConfig()
        port = (try? c.decode(Int.self, forKey: .port)).flatMap { (1...65535).contains($0) ? $0 : nil } ?? d.port
        publicOrigin = (try? c.decode(String.self, forKey: .publicOrigin)) ?? d.publicOrigin
        connection = (try? c.decode(ConnectionMode.self, forKey: .connection)) ?? d.connection
        hostname = (try? c.decode(String.self, forKey: .hostname)) ?? d.hostname
        domainHostname = (try? c.decode(String.self, forKey: .domainHostname)) ?? d.domainHostname
        tailscaleOrigin = (try? c.decode(String.self, forKey: .tailscaleOrigin)) ?? d.tailscaleOrigin
        defaultQuality = (try? c.decode(String.self, forKey: .defaultQuality)) ?? d.defaultQuality
        keepAwake = (try? c.decode(Bool.self, forKey: .keepAwake)) ?? d.keepAwake
        paused = (try? c.decode(Bool.self, forKey: .paused)) ?? d.paused
        checkForUpdates = (try? c.decode(Bool.self, forKey: .checkForUpdates)) ?? d.checkForUpdates
        betaUpdates = (try? c.decode(Bool.self, forKey: .betaUpdates)) ?? d.betaUpdates
    }

    public static func load(from url: URL) -> AppConfig {
        guard let data = try? Data(contentsOf: url), let config = try? JSONDecoder().decode(AppConfig.self, from: data) else { return AppConfig() }
        return config
    }

    public func encoded() throws -> Data {
        let encoder = JSONEncoder()
        encoder.outputFormatting = [.prettyPrinted, .sortedKeys, .withoutEscapingSlashes]
        return try encoder.encode(self)
    }

    public func save(to url: URL) throws { try SecureFiles.write(encoded(), to: url) }

    /// Sets `publicOrigin` and `hostname` for the mode. `quickURL` is the tunnel's
    /// address of this run, if it has one yet.
    public mutating func applyAddress(quickURL: String?) {
        switch connection {
        case .none:
            hostname = ""
            publicOrigin = ""
        case .quick:
            publicOrigin = quickURL.flatMap(Address.normalizeOrigin) ?? ""
            hostname = Address.host(of: publicOrigin) ?? ""
        case .domain:
            publicOrigin = Address.isValidHostname(domainHostname) ? "https://\(domainHostname.lowercased())" : ""
            hostname = Address.isValidHostname(domainHostname) ? domainHostname.lowercased() : ""
        case .tailscale:
            publicOrigin = Address.normalizeOrigin(tailscaleOrigin) ?? ""
            hostname = Address.host(of: publicOrigin) ?? ""
        }
    }

    /// The address to show and to put in the QR code; empty until there is one.
    public var address: String { publicOrigin }
}

public enum Address {
    /// A typed address as an HTTPS origin: scheme added when missing, path and trailing
    /// slash removed. Nil unless it is https on a public host name (the server refuses
    /// plain http there, and IP addresses, which cannot have passkeys).
    public static func normalizeOrigin(_ typed: String) -> String? {
        var s = typed.trimmingCharacters(in: .whitespacesAndNewlines)
        if s.isEmpty { return nil }
        if !s.contains("://") { s = "https://" + s }
        guard let c = URLComponents(string: s), c.scheme?.lowercased() == "https",
              let host = c.host?.lowercased(), isValidHostname(host), !host.hasSuffix(".localhost"),
              !host.split(separator: ".").allSatisfy({ $0.allSatisfy(\.isNumber) }),
              c.user == nil, c.password == nil else { return nil }
        let port = c.port.map { ":\($0)" } ?? ""
        return "https://\(host)\(port)"
    }

    public static func host(of origin: String) -> String? { URLComponents(string: origin)?.host }

    /// A DNS name with at least two labels, letters, digits and hyphens.
    public static func isValidHostname(_ s: String) -> Bool {
        let labels = s.lowercased().split(separator: ".", omittingEmptySubsequences: false)
        guard labels.count >= 2, s.count <= 253 else { return false }
        return labels.allSatisfy { l in
            !l.isEmpty && l.count <= 63 && !l.hasPrefix("-") && !l.hasSuffix("-")
                && l.allSatisfy { ($0.isASCII && ($0.isLetter || $0.isNumber)) || $0 == "-" }
        }
    }

    /// The tunnel's name in the Cloudflare account: `castpane-<this Mac>`.
    public static func tunnelName(computerName: String) -> String {
        let cleaned = computerName.lowercased().map { c -> Character in (c.isASCII && (c.isLetter || c.isNumber)) ? c : "-" }
        let collapsed = String(cleaned).split(separator: "-").joined(separator: "-")
        return "castpane-" + (collapsed.isEmpty ? "mac" : String(collapsed.prefix(40)))
    }
}

/// When to start a supervised child again after it exits: doubling from `base` up to
/// `cap`, and back to `base` once a run lasted `stableAfter` seconds.
public struct Backoff: Equatable, Sendable {
    public var base: TimeInterval
    public var cap: TimeInterval
    public var stableAfter: TimeInterval
    public private(set) var failures = 0

    public init(base: TimeInterval = 1, cap: TimeInterval = 60, stableAfter: TimeInterval = 60) {
        self.base = base
        self.cap = cap
        self.stableAfter = stableAfter
    }

    /// The wait before the next start, given how long the last run lasted.
    public mutating func next(afterRunning ran: TimeInterval) -> TimeInterval {
        if ran >= stableAfter { failures = 0 }
        let delay = min(cap, base * pow(2, Double(min(failures, 30))))
        failures += 1
        return delay
    }

    public mutating func reset() { failures = 0 }
}
