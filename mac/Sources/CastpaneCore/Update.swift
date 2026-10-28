import Foundation

/// A release version as Castpane's tags write it: `0.1.3`, `v0.1.3`, `0.1.3-beta`,
/// `0.1.3-beta.2`. A version without a pre-release part is newer than one with it.
public struct ReleaseVersion: Comparable, Sendable, CustomStringConvertible {
    public let numbers: [Int]
    /// Empty for a stable release.
    public let prerelease: String

    public init?(_ text: String) {
        var s = Substring(text.trimmingCharacters(in: .whitespaces))
        if s.hasPrefix("v") || s.hasPrefix("V") { s = s.dropFirst() }
        let parts = s.split(separator: "-", maxSplits: 1, omittingEmptySubsequences: false)
        guard let core = parts.first, !core.isEmpty else { return nil }
        let nums = core.split(separator: ".", omittingEmptySubsequences: false).map { Int($0) }
        guard (1...4).contains(nums.count), nums.allSatisfy({ $0 != nil && $0! >= 0 }) else { return nil }
        numbers = nums.map { $0! }
        prerelease = parts.count > 1 ? String(parts[1]) : ""
        if parts.count > 1 && prerelease.isEmpty { return nil }
    }

    public var description: String { numbers.map(String.init).joined(separator: ".") + (prerelease.isEmpty ? "" : "-" + prerelease) }

    public static func < (a: Self, b: Self) -> Bool {
        let n = max(a.numbers.count, b.numbers.count)
        for i in 0..<n {
            let x = i < a.numbers.count ? a.numbers[i] : 0, y = i < b.numbers.count ? b.numbers[i] : 0
            if x != y { return x < y }
        }
        if a.prerelease.isEmpty != b.prerelease.isEmpty { return !a.prerelease.isEmpty }
        return a.prerelease.compare(b.prerelease, options: .numeric) == .orderedAscending
    }

    public static func == (a: Self, b: Self) -> Bool { !(a < b) && !(b < a) }
}

/// One release from GitHub's releases API, with the disk image for this Mac.
public struct AvailableUpdate: Equatable, Sendable {
    public let version: String
    public let tag: String
    public let prerelease: Bool
    public let notes: String
    public let page: String
    public let imageName: String
    public let imageURL: URL
    /// The image's SHA-256 as GitHub records it for the uploaded file, in lowercase hex.
    public let sha256: String

    public init(version: String, tag: String, prerelease: Bool, notes: String, page: String, imageName: String, imageURL: URL, sha256: String) {
        self.version = version; self.tag = tag; self.prerelease = prerelease; self.notes = notes; self.page = page
        self.imageName = imageName; self.imageURL = imageURL; self.sha256 = sha256
    }
}

public enum UpdateCheck {
    /// The newest release newer than `current` with a disk image for `arch` (arm64 or
    /// x86_64) and a SHA-256 digest; betas only when `includeBeta`. Drafts never count, and
    /// only `https://github.com/` image addresses are taken.
    public static func newest(in json: Data, current: String, arch: String, includeBeta: Bool) -> AvailableUpdate? {
        guard let now = ReleaseVersion(current),
              let list = (try? JSONSerialization.jsonObject(with: json)) as? [[String: Any]] else { return nil }
        var best: (ReleaseVersion, AvailableUpdate)?
        for r in list {
            guard (r["draft"] as? Bool) != true,
                  let tag = r["tag_name"] as? String, let v = ReleaseVersion(tag), v > now else { continue }
            let pre = (r["prerelease"] as? Bool) ?? false
            if (pre || !v.prerelease.isEmpty) && !includeBeta { continue }
            guard let assets = r["assets"] as? [[String: Any]] else { continue }
            let suffix = "-\(arch).dmg"
            guard let a = assets.first(where: { ($0["name"] as? String)?.hasPrefix("Castpane-") == true && ($0["name"] as? String)?.hasSuffix(suffix) == true }),
                  let name = a["name"] as? String,
                  let link = a["browser_download_url"] as? String, let url = URL(string: link),
                  url.scheme == "https", url.host == "github.com",
                  let digest = a["digest"] as? String, digest.hasPrefix("sha256:") else { continue }
            let hex = String(digest.dropFirst(7)).lowercased()
            guard hex.count == 64, hex.allSatisfy(\.isHexDigit) else { continue }
            let update = AvailableUpdate(version: v.description, tag: tag, prerelease: pre || !v.prerelease.isEmpty,
                                         notes: (r["body"] as? String) ?? "", page: (r["html_url"] as? String) ?? "",
                                         imageName: name, imageURL: url, sha256: hex)
            if best == nil || v > best!.0 { best = (v, update) }
        }
        return best?.1
    }

    /// The API address of a repository's releases (`owner/name`), or nil for anything else.
    public static func releasesURL(repo: String) -> URL? {
        let parts = repo.split(separator: "/")
        let ok = { (s: Substring) in !s.isEmpty && s.count <= 100 && !s.allSatisfy { $0 == "." }
            && s.allSatisfy { $0.isASCII && ($0.isLetter || $0.isNumber || "-_.".contains($0)) } }
        guard parts.count == 2, ok(parts[0]), ok(parts[1]) else { return nil }
        return URL(string: "https://api.github.com/repos/\(parts[0])/\(parts[1])/releases?per_page=20")
    }
}
