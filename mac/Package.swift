// swift-tools-version:6.0
// Castpane.app: the Mac side of castpane. A menu-bar app that starts the castpane server,
// captures the screen or one window on the hardware H.264 encoder, posts the clicks and
// keys a viewer sends, and manages the tunnel that makes the server reachable.
//
// CastpaneCore holds the pure logic (config files, backoff, tunnel state and the parsing
// of cloudflared's output) so it can be unit tested without a screen or a network.
import Foundation
import PackageDescription

let package = Package(
    name: "Castpane",
    platforms: [.macOS(.v14)],
    targets: [
        .target(name: "CastpaneCore", path: "Sources/CastpaneCore"),
        .target(
            name: "CastpaneHost",
            path: "Sources/CastpaneHost",
            linkerSettings: [
                .linkedFramework("ScreenCaptureKit"),
                .linkedFramework("VideoToolbox"),
                .linkedFramework("CoreMedia"),
                .linkedFramework("ApplicationServices"),
                .linkedFramework("AppKit"),
            ]
        ),
        .executableTarget(
            name: "Castpane",
            dependencies: ["CastpaneCore", "CastpaneHost"],
            path: "Sources/Castpane",
            linkerSettings: [
                .linkedFramework("ServiceManagement"),
                .linkedFramework("IOKit"),
                .linkedFramework("CoreImage"),
                .linkedFramework("Security"),
            ]
        ),
    ],
    swiftLanguageModes: [.v6]
)

// The test suites are kept separately; when they are present next to this file, build them.
if FileManager.default.fileExists(atPath: Context.packageDirectory + "/Tests/CastpaneCoreTests") {
    package.targets.append(.testTarget(name: "CastpaneCoreTests", dependencies: ["CastpaneCore", "CastpaneHost"],
                                       path: "Tests/CastpaneCoreTests"))
}
