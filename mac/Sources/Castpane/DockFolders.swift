import Foundation
import AppKit

/// The folders kept at the right of this Mac's Dock (Downloads, Documents…). macOS asks once
/// before Castpane may open one of them; asked from the phone, that question waits on the Mac
/// where nobody sees it. Asked here instead, at the Mac, all at once: each folder is read once,
/// off the main thread (a question there waits for its answer), and what came of it is kept.
enum DockFolders {
    static let keptKey = "dockFoldersAsked"

    /// The Dock's folders, by name and URL, as the capture core lists them (local, existing).
    static func list() -> [(name: String, url: URL)] {
        let tiles = CFPreferencesCopyAppValue("persistent-others" as CFString, "com.apple.dock" as CFString) as? [[String: Any]] ?? []
        return tiles.compactMap { tile in
            guard let data = tile["tile-data"] as? [String: Any], let file = data["file-data"] as? [String: Any],
                  let s = file["_CFURLString"] as? String else { return nil }
            let url: URL? = s.hasPrefix("/") ? URL(fileURLWithPath: s) : URL(string: s)
            guard let url, url.isFileURL else { return nil }
            var isDir: ObjCBool = false
            guard FileManager.default.fileExists(atPath: url.path, isDirectory: &isDir), isDir.boolValue,
                  !NSWorkspace.shared.isFilePackage(atPath: url.path) else { return nil }
            let label = (data["file-label"] as? String).flatMap { $0.isEmpty ? nil : $0 } ?? FileManager.default.displayName(atPath: url.path)
            return (label, url)
        }
    }

    /// Reads each folder once (macOS asks then, here), and says which could be read.
    static func ask(done: @escaping @Sendable ([String: Bool]) -> Void) {
        DispatchQueue(label: "castpane.dock-folders").async {
            var out: [String: Bool] = [:]
            for f in list() {
                // Opening it and reading one entry is enough for macOS to ask (or to say no).
                var readable = false
                if let dir = opendir(f.url.path) { _ = readdir(dir);closedir(dir);readable = true }
                out[f.name] = readable
            }
            UserDefaults.standard.set(out, forKey: keptKey)
            done(out)
        }
    }

    /// What the last asking found, if it was asked.
    static var kept: [String: Bool]? { UserDefaults.standard.dictionary(forKey: keptKey) as? [String: Bool] }
}
