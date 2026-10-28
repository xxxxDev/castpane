import Foundation
import CryptoKit
import Security

/// What the app reads from cloudflared's output.
public enum CloudflaredOutput {
    /// The quick tunnel's address, from a line such as
    /// `INF |  https://some-random-words.trycloudflare.com  |`.
    public static func quickURL(in text: String) -> String? {
        firstMatch(#"https://[a-z0-9](?:[a-z0-9-]*[a-z0-9])?\.trycloudflare\.com"#, in: text.lowercased())
    }

    /// The page `tunnel login` asks to open (it also tries to open it itself).
    public static func loginURL(in text: String) -> String? {
        firstMatch(#"https://dash\.cloudflare\.com/argotunnel\S*"#, in: text)
    }

    /// The tunnel's id from `tunnel create -o json` or from its plain
    /// "Created tunnel <name> with id <uuid>" line.
    public static func tunnelID(in text: String) -> String? {
        if let data = text.data(using: .utf8), let obj = try? JSONSerialization.jsonObject(with: data) as? [String: Any],
           let id = obj["id"] as? String { return id.lowercased() }
        return firstMatch(#"[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}"#, in: text.lowercased())
    }

    /// The id of the tunnel called `name` in `tunnel list -o json`.
    public static func tunnelID(named name: String, inList text: String) -> String? {
        guard let data = text.data(using: .utf8), let list = try? JSONSerialization.jsonObject(with: data) as? [[String: Any]] else { return nil }
        let live = list.filter { ($0["name"] as? String) == name && ($0["deleted_at"] == nil || $0["deleted_at"] is NSNull || ($0["deleted_at"] as? String)?.hasPrefix("0001") == true) }
        return (live.first?["id"] as? String)?.lowercased()
    }

    /// Whether the tunnel has a live connection to Cloudflare's edge.
    public static func isConnected(_ line: String) -> Bool {
        line.contains("Registered tunnel connection") || line.contains("Connection registered")
    }

    /// A tunnel create that failed because the name is already taken in the account.
    public static func alreadyExists(_ text: String) -> Bool { text.lowercased().contains("already exists") }

    static func firstMatch(_ pattern: String, in text: String) -> String? {
        guard let re = try? NSRegularExpression(pattern: pattern),
              let m = re.firstMatch(in: text, range: NSRange(text.startIndex..., in: text)),
              let r = Range(m.range, in: text) else { return nil }
        return String(text[r])
    }
}

/// The cloudflared release for this Mac, from Cloudflare's GitHub releases.
public enum CloudflaredRelease {
    public static let latestAPI = URL(string: "https://api.github.com/repos/cloudflare/cloudflared/releases/latest")!
    /// Cloudflare's Apple Developer team: the binary must be signed by it.
    public static let teamID = "68WVV388M8"

    public static func assetName(arm64: Bool) -> String { arm64 ? "cloudflared-darwin-arm64.tgz" : "cloudflared-darwin-amd64.tgz" }

    public static var assetNameForThisMac: String {
        #if arch(arm64)
        return assetName(arm64: true)
        #else
        return assetName(arm64: false)
        #endif
    }

    public struct Asset: Equatable, Sendable {
        public let tag: String
        public let url: URL
        /// SHA-256 of the .tgz, as GitHub records it for the asset.
        public let archiveSHA256: String?
        /// SHA-256 of the cloudflared binary inside, as Cloudflare lists it in the notes.
        public let binarySHA256: String?
    }

    /// Picks this Mac's asset from the releases API's JSON. At least one checksum must
    /// be published, or there is nothing to verify against and the release is refused.
    public static func asset(fromReleaseJSON data: Data, name: String = assetNameForThisMac) -> Asset? {
        guard let obj = try? JSONSerialization.jsonObject(with: data) as? [String: Any],
              let assets = obj["assets"] as? [[String: Any]],
              let a = assets.first(where: { ($0["name"] as? String) == name }),
              let link = a["browser_download_url"] as? String, let url = URL(string: link),
              url.scheme == "https", url.host == "github.com" else { return nil }
        let digest = (a["digest"] as? String).flatMap { d -> String? in
            d.hasPrefix("sha256:") ? String(d.dropFirst(7)).lowercased() : nil
        }.flatMap { isHexDigest($0) ? $0 : nil }
        let listed = checksums(inNotes: obj["body"] as? String ?? "")[name]
        guard digest != nil || listed != nil else { return nil }
        return Asset(tag: obj["tag_name"] as? String ?? "", url: url, archiveSHA256: digest, binarySHA256: listed)
    }

    /// `file: sha256` lines from the release notes.
    public static func checksums(inNotes body: String) -> [String: String] {
        var out: [String: String] = [:]
        for line in body.split(whereSeparator: \.isNewline) {
            let parts = line.split(separator: ":", maxSplits: 1).map { $0.trimmingCharacters(in: .whitespaces) }
            guard parts.count == 2, isHexDigest(parts[1].lowercased()) else { continue }
            out[parts[0]] = parts[1].lowercased()
        }
        return out
    }

    /// A valid signature from Cloudflare's Developer ID team.
    public static func isSignedByCloudflare(_ url: URL) -> Bool {
        var code: SecStaticCode?
        guard SecStaticCodeCreateWithPath(url as CFURL, [], &code) == errSecSuccess, let code else { return false }
        var requirement: SecRequirement?
        let text = "anchor apple generic and certificate leaf[subject.OU] = \"\(teamID)\"" as CFString
        guard SecRequirementCreateWithString(text, [], &requirement) == errSecSuccess else { return false }
        return SecStaticCodeCheckValidity(code, SecCSFlags(rawValue: kSecCSCheckAllArchitectures), requirement) == errSecSuccess
    }

    /// The cloudflared to use if one is already on this Mac: Castpane's own download, or
    /// one in `searchDirs` (absolute folders only, symbolic links resolved). Each must be
    /// executable and pass `isTrusted` (Cloudflare's signature), the same check a download
    /// passes; one that does not is skipped, and with none the caller downloads its own.
    public static func installed(own: URL?, searchDirs: [String],
                                 isExecutable: (String) -> Bool = { FileManager.default.isExecutableFile(atPath: $0) },
                                 isTrusted: (URL) -> Bool = isSignedByCloudflare) -> URL? {
        if let own, isExecutable(own.path), isTrusted(own) { return own }
        var seen = Set<String>()
        for dir in searchDirs where dir.hasPrefix("/") {
            // The file the link points at is the one checked and the one run.
            let candidate = URL(fileURLWithPath: dir).appendingPathComponent("cloudflared").resolvingSymlinksInPath()
            guard seen.insert(candidate.path).inserted, isExecutable(candidate.path), isTrusted(candidate) else { continue }
            return candidate
        }
        return nil
    }

    public enum AdoptFailure: Error, Equatable { case copy(String), notTrusted }

    /// Copies a cloudflared found elsewhere (Homebrew, /usr/local/bin) to `own`, in its own
    /// 0700 folder, and returns `own` once the copy itself passes `isTrusted`. The app runs
    /// only that copy: an upgrade that removes or replaces the original cannot break a
    /// restart or swap what runs, and nothing outside Castpane's folder is run.
    public static func adopt(_ found: URL, as own: URL, isTrusted: (URL) -> Bool = isSignedByCloudflare) throws -> URL {
        if found.standardizedFileURL.path == own.standardizedFileURL.path { return own }
        let dir = own.deletingLastPathComponent()
        try SecureFiles.ensureDirectory(dir)
        let temp = dir.appendingPathComponent(".\(own.lastPathComponent).\(UUID().uuidString).tmp")
        do { try FileManager.default.copyItem(at: found, to: temp) } catch { throw AdoptFailure.copy(error.localizedDescription) }
        guard chmod(temp.path, 0o700) == 0, isTrusted(temp) else {
            try? FileManager.default.removeItem(at: temp)
            throw AdoptFailure.notTrusted
        }
        guard rename(temp.path, own.path) == 0 else {
            let e = errno
            try? FileManager.default.removeItem(at: temp)
            throw AdoptFailure.copy(String(cString: strerror(e)))
        }
        return own
    }

    public static func isHexDigest(_ s: String) -> Bool { s.count == 64 && s.allSatisfy(\.isHexDigit) }

    public static func sha256(_ data: Data) -> String { SHA256.hash(data: data).map { String(format: "%02x", $0) }.joined() }

    public static func sha256(fileAt url: URL) throws -> String {
        let handle = try FileHandle(forReadingFrom: url)
        defer { try? handle.close() }
        var hasher = SHA256()
        while let chunk = try handle.read(upToCount: 1 << 20), !chunk.isEmpty { hasher.update(data: chunk) }
        return hasher.finalize().map { String(format: "%02x", $0) }.joined()
    }
}

/// cloudflared/config.yml for the own-domain tunnel.
public enum CloudflaredConfigFile {
    public static func yaml(tunnelID: String, credentialsFile: String, hostname: String, port: Int) -> String {
        """
        # Written by Castpane. Changes here are replaced when the connection is set up again.
        tunnel: \(quote(tunnelID))
        credentials-file: \(quote(credentialsFile))
        no-autoupdate: true
        ingress:
          - hostname: \(quote(hostname))
            service: \(quote("http://127.0.0.1:\(port)"))
          - service: http_status:404

        """
    }

    /// The tunnel id and host name back from a file this app wrote, to tell whether it
    /// still matches the settings.
    public static func parse(_ yaml: String) -> (tunnelID: String, hostname: String)? {
        func value(_ key: String) -> String? {
            for line in yaml.split(whereSeparator: \.isNewline) {
                let t = line.trimmingCharacters(in: .whitespaces).replacingOccurrences(of: "- ", with: "")
                guard t.hasPrefix(key + ":") else { continue }
                var v = t.dropFirst(key.count + 1).trimmingCharacters(in: .whitespaces)
                if v.hasPrefix("\""), v.hasSuffix("\""), v.count >= 2 { v = String(v.dropFirst().dropLast()) }
                return v.replacingOccurrences(of: "\\\"", with: "\"").replacingOccurrences(of: "\\\\", with: "\\")
            }
            return nil
        }
        guard let id = value("tunnel"), let host = value("hostname") else { return nil }
        return (id, host)
    }

    static func quote(_ s: String) -> String {
        "\"" + s.replacingOccurrences(of: "\\", with: "\\\\").replacingOccurrences(of: "\"", with: "\\\"") + "\""
    }
}
