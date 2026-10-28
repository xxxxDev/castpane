import AppKit
import CryptoKit
import Foundation
import Security
import CastpaneCore

/// Finds a newer release on GitHub and installs it in place of this app.
///
/// An update is installed only if every check passes: the disk image matches the SHA-256
/// GitHub records for it, and the app inside satisfies this app's own designated
/// requirement (the same identifier, signed with the same certificate). An app built
/// without a certificate (ad hoc) has no such requirement to share, so it does not update
/// itself. The swap happens after Castpane quits, by a small script that then opens the
/// new app; if the swap fails, the old app is put back.
@MainActor
final class Updater: ObservableObject {
    enum State: Equatable {
        case idle
        case checking
        case upToDate
        case available(AvailableUpdate)
        case working(String)
        case failed(String)
    }

    @Published private(set) var state: State = .idle
    @Published private(set) var lastChecked: Date?

    private let paths: Paths
    private var timer: Timer?
    private static let lastCheckKey = "updateLastCheck"
    private static let offeredKey = "updateOfferedVersion"

    /// Shown when an automatic check finds something new (once per version).
    var onOffer: ((AvailableUpdate) -> Void)?

    init(paths: Paths) {
        self.paths = paths
        lastChecked = UserDefaults.standard.object(forKey: Self.lastCheckKey) as? Date
    }

    static var currentVersion: String {
        (Bundle.main.object(forInfoDictionaryKey: "CastpaneVersion") as? String)
            ?? (Bundle.main.object(forInfoDictionaryKey: "CFBundleShortVersionString") as? String) ?? "0"
    }

    static var repo: String { (Bundle.main.object(forInfoDictionaryKey: "CastpaneUpdateRepo") as? String) ?? "" }

    static var arch: String {
        #if arch(arm64)
        return "arm64"
        #else
        return "x86_64"
        #endif
    }

    /// Why this copy cannot update itself, if it cannot.
    static var cannotUpdate: String? {
        if MacInfo.signedAdHoc { return "This build is signed ad hoc, so it cannot check that an update comes from the same signer. Update it by hand." }
        if UpdateCheck.releasesURL(repo: repo) == nil { return "This build does not name a repository to update from." }
        let path = Bundle.main.bundleURL.path
        if path.contains("/AppTranslocation/") { return "Move Castpane to Applications first: macOS is running it from a temporary place." }
        if !FileManager.default.isWritableFile(atPath: Bundle.main.bundleURL.deletingLastPathComponent().path) {
            return "Castpane cannot replace itself in \(Bundle.main.bundleURL.deletingLastPathComponent().path); update it by hand."
        }
        return nil
    }

    private var enabled: () -> Bool = { false }
    private var includeBeta: () -> Bool = { false }

    /// Checks once a day while `enabled`, the first time a minute after launch.
    func schedule(enabled: @escaping () -> Bool, includeBeta: @escaping () -> Bool) {
        self.enabled = enabled
        self.includeBeta = includeBeta
        // What a past update left (the image, the script): it is done by now.
        try? FileManager.default.removeItem(at: paths.home.appendingPathComponent("updates", isDirectory: true))
        timer?.invalidate()
        timer = Timer.scheduledTimer(withTimeInterval: 3600, repeats: true) { [weak self] _ in MainActor.assumeIsolated { self?.tick() } }
        Timer.scheduledTimer(withTimeInterval: 60, repeats: false) { [weak self] _ in MainActor.assumeIsolated { self?.tick() } }
    }

    private func tick() {
        guard enabled(), Self.cannotUpdate == nil else { return }
        if let last = lastChecked, Date().timeIntervalSince(last) < 24 * 3600 { return }
        let beta = includeBeta()
        Task { await check(includeBeta: beta, automatic: true) }
    }

    func check(includeBeta: Bool, automatic: Bool = false) async {
        if case .working = state { return }
        guard let url = UpdateCheck.releasesURL(repo: Self.repo) else { state = .failed("No repository to update from."); return }
        state = .checking
        var request = URLRequest(url: url, cachePolicy: .reloadIgnoringLocalCacheData, timeoutInterval: 20)
        request.setValue("application/vnd.github+json", forHTTPHeaderField: "Accept")
        request.setValue("Castpane/\(Self.currentVersion)", forHTTPHeaderField: "User-Agent")
        do {
            let (data, response) = try await URLSession.shared.data(for: request)
            guard (response as? HTTPURLResponse)?.statusCode == 200 else {
                state = .failed("GitHub answered \((response as? HTTPURLResponse)?.statusCode ?? 0).")
                return
            }
            // An install started while this check waited for GitHub goes on undisturbed.
            if case .working = state { return }
            lastChecked = Date()
            UserDefaults.standard.set(lastChecked, forKey: Self.lastCheckKey)
            if let update = UpdateCheck.newest(in: data, current: Self.currentVersion, arch: Self.arch, includeBeta: includeBeta, repo: Self.repo) {
                state = .available(update)
                if automatic, UserDefaults.standard.string(forKey: Self.offeredKey) != update.version {
                    UserDefaults.standard.set(update.version, forKey: Self.offeredKey)
                    onOffer?(update)
                }
            } else {
                state = .upToDate
            }
        } catch {
            if case .working = state { return }
            state = .failed("Could not reach GitHub: \(error.localizedDescription)")
        }
    }

    /// Downloads, checks and stages the update, then quits so the script can swap it in.
    func install(_ update: AvailableUpdate) async {
        await install(update, image: nil, relaunch: true)
    }

    /// `image`: an image already on disk (debug self-test), instead of the download.
    /// `relaunch`: false keeps the script from opening the new app (debug self-test).
    func install(_ update: AvailableUpdate, image local: URL?, relaunch: Bool) async {
        if case .working = state { return }
        if let reason = Self.cannotUpdate { state = .failed(reason); return }
        guard let requirement = Self.ownRequirement() else { state = .failed("Castpane could not read its own signature."); return }
        let dir = paths.home.appendingPathComponent("updates", isDirectory: true)
        let dest = Bundle.main.bundleURL
        // Staged in Castpane's own folder (0700), not next to the app: nobody else can put
        // anything at that path before the copy, or change it after the check.
        let staged = dir.appendingPathComponent("new", isDirectory: true).appendingPathComponent("Castpane.app", isDirectory: true)
        let fm = FileManager.default
        state = .working("Starting…")
        do {
            try? fm.removeItem(at: dir)
            try SecureFiles.ensureDirectory(dir)
            try SecureFiles.ensureDirectory(staged.deletingLastPathComponent())

            let image = dir.appendingPathComponent("update.dmg")
            if let local {
                try fm.copyItem(at: local, to: image)
            } else {
                state = .working("Downloading \(update.imageName)…")
                let (tmp, response) = try await URLSession.shared.download(from: update.imageURL)
                guard (response as? HTTPURLResponse)?.statusCode == 200 else { throw Failure("the download answered \((response as? HTTPURLResponse)?.statusCode ?? 0)") }
                try fm.moveItem(at: tmp, to: image)
            }

            state = .working("Checking the download…")
            let digest = try await Task.detached { try Self.sha256(of: image) }.value
            guard digest == update.sha256 else { throw Failure("the download does not match the SHA-256 GitHub records for it") }

            state = .working("Opening the disk image…")
            let mount = dir.appendingPathComponent("mount", isDirectory: true)
            try fm.createDirectory(at: mount, withIntermediateDirectories: true)
            try await Self.run("/usr/bin/hdiutil", ["attach", "-nobrowse", "-readonly", "-noautoopen", "-mountpoint", mount.path, image.path])
            let source = mount.appendingPathComponent("Castpane.app", isDirectory: true)
            let values = try? source.resourceValues(forKeys: [.isSymbolicLinkKey, .isDirectoryKey])
            let copied: Result<Void, Error>
            if values?.isDirectory == true, values?.isSymbolicLink != true {
                state = .working("Checking the new version…")
                do { try await Self.run("/usr/bin/ditto", ["--noacl", source.path, staged.path]); copied = .success(()) } catch { copied = .failure(error) }
            } else {
                copied = .failure(Failure("the disk image holds no Castpane.app"))
            }
            // The image is no longer needed, whatever happened.
            try? await Self.run("/usr/bin/hdiutil", ["detach", "-force", mount.path])
            try copied.get()
            // The signature covers the contents, not who may write them: the copy is made
            // this user's alone before it is checked.
            try Self.tighten(staged)
            // The copy, not the image, is what will run: it is the one checked.
            guard Self.satisfies(staged, requirement) else {
                try? fm.removeItem(at: staged)
                throw Failure("the new app is not signed by the same signer as this one")
            }
            let newVersion = Bundle(url: staged)?.object(forInfoDictionaryKey: "CastpaneVersion") as? String
            guard newVersion == update.version else {
                try? fm.removeItem(at: staged)
                throw Failure("the new app says it is \(newVersion ?? "no version"), not \(update.version)")
            }

            state = .working("Restarting into Castpane \(update.version)…")
            let script = dir.appendingPathComponent("apply.sh")
            try Self.applyScript.write(to: script, atomically: true, encoding: .utf8)
            let p = Process()
            p.executableURL = URL(fileURLWithPath: "/bin/sh")
            p.arguments = [script.path, String(ProcessInfo.processInfo.processIdentifier), dest.path, staged.path, relaunch ? "open" : "no"]
            p.standardInput = FileHandle.nullDevice
            p.standardOutput = FileHandle.nullDevice
            p.standardError = FileHandle.nullDevice
            try p.run()
            if relaunch { NSApp.terminate(nil) } else { exit(0) }
        } catch {
            try? fm.removeItem(at: staged)
            state = .failed("Update not installed: \((error as? Failure)?.text ?? error.localizedDescription).")
        }
    }

    /// Waits for Castpane to quit, swaps the staged app in (the old one is put back if a
    /// step fails) and opens it. The paths come as arguments, never inside the script.
    private static let applyScript = """
    #!/bin/sh
    pid=$1; dest=$2; staged=$3; reopen=$4
    i=0
    while kill -0 "$pid" 2>/dev/null; do i=$((i+1)); [ "$i" -gt 600 ] && exit 1; sleep 0.1; done
    [ -d "$staged" ] && [ ! -L "$staged" ] || exit 1
    # The old app waits in Castpane's own folder (beside the staged one) until the new one is in.
    old="$(dirname "$staged")/previous.app"
    rm -rf "$old"
    if mv "$dest" "$old"; then
      if mv "$staged" "$dest"; then rm -rf "$old"; else mv "$old" "$dest"; fi
    fi
    rm -rf "$staged"
    [ "$reopen" = "open" ] && open "$dest"
    exit 0
    """

    nonisolated struct Failure: Error { let text: String; init(_ t: String) { text = t } }

    /// Every item must be this user's own directory, file or symbolic link; group and others
    /// lose write access, and set-id bits go.
    nonisolated static func tighten(_ root: URL) throws {
        var paths = [root.path]
        if let e = FileManager.default.enumerator(atPath: root.path) {
            while let rel = e.nextObject() as? String { paths.append(root.path + "/" + rel) }
        }
        let uid = getuid()
        for path in paths {
            var st = stat()
            guard lstat(path, &st) == 0 else { throw Failure("could not read \(path)") }
            let kind = st.st_mode & S_IFMT
            guard kind == S_IFDIR || kind == S_IFREG || kind == S_IFLNK else { throw Failure("the new app holds a special file") }
            guard st.st_uid == uid else { throw Failure("the new app holds a file owned by someone else") }
            if kind != S_IFLNK {
                let mode = st.st_mode & 0o7777 & ~mode_t(0o6022)
                guard chmod(path, mode) == 0 else { throw Failure("could not set permissions in the new app") }
            }
        }
    }

    nonisolated static func sha256(of file: URL) throws -> String {
        let handle = try FileHandle(forReadingFrom: file)
        defer { try? handle.close() }
        var hasher = SHA256()
        while let chunk = try handle.read(upToCount: 1 << 20), !chunk.isEmpty { hasher.update(data: chunk) }
        return hasher.finalize().map { String(format: "%02x", $0) }.joined()
    }

    nonisolated static func run(_ tool: String, _ args: [String]) async throws {
        try await withCheckedThrowingContinuation { (done: CheckedContinuation<Void, Error>) in
            let p = Process()
            p.executableURL = URL(fileURLWithPath: tool)
            p.arguments = args
            p.standardInput = FileHandle.nullDevice
            p.standardOutput = FileHandle.nullDevice
            p.standardError = FileHandle.nullDevice
            p.terminationHandler = { p in
                p.terminationStatus == 0 ? done.resume() : done.resume(throwing: Failure("\((tool as NSString).lastPathComponent) failed (\(p.terminationStatus))"))
            }
            do { try p.run() } catch { done.resume(throwing: error) }
        }
    }

    /// This app's designated requirement: its identifier and the certificate it is signed with.
    static func ownRequirement() -> SecRequirement? {
        var code: SecCode?
        guard SecCodeCopySelf([], &code) == errSecSuccess, let code else { return nil }
        var staticCode: SecStaticCode?
        guard SecCodeCopyStaticCode(code, [], &staticCode) == errSecSuccess, let staticCode else { return nil }
        var requirement: SecRequirement?
        guard SecCodeCopyDesignatedRequirement(staticCode, [], &requirement) == errSecSuccess else { return nil }
        return requirement
    }

    /// Whether the app at `url` is validly signed, nested code included, and meets `requirement`.
    nonisolated static func satisfies(_ url: URL, _ requirement: SecRequirement) -> Bool {
        var staticCode: SecStaticCode?
        guard SecStaticCodeCreateWithPath(url as CFURL, [], &staticCode) == errSecSuccess, let staticCode else { return false }
        let flags = SecCSFlags(rawValue: kSecCSCheckAllArchitectures | kSecCSStrictValidate | kSecCSCheckNestedCode)
        return SecStaticCodeCheckValidity(staticCode, flags, requirement) == errSecSuccess
    }
}
