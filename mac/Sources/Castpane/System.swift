import AppKit
import ApplicationServices
import CoreImage
import CoreImage.CIFilterBuiltins
import IOKit.ps
import IOKit.pwr_mgt
import ServiceManagement
import SystemConfiguration

/// Screen Recording and Accessibility, as macOS grants them to this app.
enum Permissions {
    static var screen: Bool { CGPreflightScreenCaptureAccess() }
    static var accessibility: Bool { AXIsProcessTrusted() }

    static func requestScreen() { _ = CGRequestScreenCaptureAccess() }

    static func requestAccessibility() {
        // kAXTrustedCheckOptionPrompt's value, spelled out (the imported global is mutable).
        _ = AXIsProcessTrustedWithOptions(["AXTrustedCheckOptionPrompt": true] as CFDictionary)
    }

    static func openScreenSettings() {
        open("x-apple.systempreferences:com.apple.preference.security?Privacy_ScreenCapture")
    }

    static func openAccessibilitySettings() {
        open("x-apple.systempreferences:com.apple.preference.security?Privacy_Accessibility")
    }

    private static func open(_ s: String) { if let url = URL(string: s) { NSWorkspace.shared.open(url) } }
}

/// Launch at login, through SMAppService. It needs the app to run from its bundle; an ad
/// hoc signed app works but may show as from an unidentified developer in Login Items.
enum LoginItem {
    static var status: SMAppService.Status { SMAppService.mainApp.status }
    static var isOn: Bool { status == .enabled }
    static var needsApproval: Bool { status == .requiresApproval }

    static func set(_ on: Bool) throws {
        if on { try SMAppService.mainApp.register() } else { try SMAppService.mainApp.unregister() }
    }

    static func openSettings() { SMAppService.openSystemSettingsLoginItems() }
}

/// Keeps the Mac from sleeping while it is on power (not on battery) and sharing is on,
/// and the display awake while a viewer is connected.
@MainActor
final class KeepAwake {
    private var system: IOPMAssertionID = 0
    private var display: IOPMAssertionID = 0
    private var timer: Timer?
    var enabled = false { didSet { update() } }
    var sharing = true { didSet { update() } }
    var viewer = false { didSet { update() } }

    init() {
        // Power source changes are rare; a check each half minute is enough.
        timer = Timer.scheduledTimer(withTimeInterval: 30, repeats: true) { [weak self] _ in
            MainActor.assumeIsolated { self?.update() }
        }
    }

    nonisolated static var onPower: Bool {
        guard let info = IOPSCopyPowerSourcesInfo()?.takeRetainedValue(),
              let type = IOPSGetProvidingPowerSourceType(info)?.takeUnretainedValue() as String? else { return true }
        return type == kIOPMACPowerKey
    }

    func update() {
        let on = enabled && sharing && Self.onPower
        hold(&system, on, kIOPMAssertPreventUserIdleSystemSleep, "Castpane is sharing this Mac")
        hold(&display, on && viewer, kIOPMAssertPreventUserIdleDisplaySleep, "Castpane has a viewer")
    }

    func release() {
        enabled = false
        timer?.invalidate()
    }

    private func hold(_ id: inout IOPMAssertionID, _ on: Bool, _ type: String, _ reason: String) {
        if on && id == 0 {
            IOPMAssertionCreateWithName(type as CFString, IOPMAssertionLevel(kIOPMAssertionLevelOn), reason as CFString, &id)
        } else if !on && id != 0 {
            IOPMAssertionRelease(id)
            id = 0
        }
    }
}

enum MacInfo {
    static var computerName: String { (SCDynamicStoreCopyComputerName(nil, nil) as String?) ?? "Mac" }

    static var version: String { Bundle.main.object(forInfoDictionaryKey: "CFBundleShortVersionString") as? String ?? "0.1.1" }

    static var inBundle: Bool { Bundle.main.bundleURL.pathExtension == "app" }

    /// Quits and opens the app again (macOS applies a new Screen Recording grant only to
    /// a fresh process). Works only when running from Castpane.app.
    @MainActor static func relaunch() {
        guard inBundle else { NSApp.terminate(nil); return }
        let pid = ProcessInfo.processInfo.processIdentifier
        let p = Process()
        p.executableURL = URL(fileURLWithPath: "/bin/sh")
        p.arguments = ["-c", "while /bin/kill -0 \(pid) 2>/dev/null; do /bin/sleep 0.2; done; /usr/bin/open \"$0\"", Bundle.main.bundlePath]
        try? p.run()
        NSApp.terminate(nil)
    }
}

enum QRCode {
    /// The text as a QR code, crisp at `size` points.
    static func image(_ text: String, size: CGFloat = 220) -> NSImage? {
        let filter = CIFilter.qrCodeGenerator()
        filter.message = Data(text.utf8)
        filter.correctionLevel = "M"
        guard let output = filter.outputImage, output.extent.width > 0 else { return nil }
        let scale = max(1, (size * 2 / output.extent.width).rounded(.down))
        let scaled = output.transformed(by: CGAffineTransform(scaleX: scale, y: scale))
        guard let cg = CIContext(options: [.useSoftwareRenderer: false]).createCGImage(scaled, from: scaled.extent) else { return nil }
        return NSImage(cgImage: cg, size: NSSize(width: scaled.extent.width / 2, height: scaled.extent.height / 2))
    }
}
