import SwiftUI

// Liquid Glass on macOS 26 and later, the closest older look before it. The app is linked
// against the current SDK (build-app.sh records it), so windows, tabs and plain controls
// take the system's glass by themselves; these cover the cards and the main buttons.
/// Snapshots draw outside the window server, which is what renders glass; there they use the
/// older look, which draws the same layout correctly.
enum GlassLook {
    /// Set once, before any window, by the snapshot run.
    nonisolated(unsafe) static var plain = false
}

extension View {
    /// A rounded glass panel around a group of content.
    @ViewBuilder func glassCard(cornerRadius: CGFloat = 18, padding: CGFloat = 16) -> some View {
        let shape = RoundedRectangle(cornerRadius: cornerRadius, style: .continuous)
        if #available(macOS 26, *), !GlassLook.plain {
            self.padding(padding).glassEffect(.regular, in: shape)
        } else {
            self.padding(padding).background(.regularMaterial, in: shape)
        }
    }

    /// The step's main action: blue-tinted glass that still lets the window show through.
    @ViewBuilder func primaryButtonStyle() -> some View {
        if #available(macOS 26, *), !GlassLook.plain {
            self.buttonStyle(.glass(.regular.tint(Palette.blue.opacity(0.55)).interactive())).foregroundStyle(.white)
        } else {
            self.buttonStyle(.borderedProminent)
        }
    }

    /// Clear glass, untinted (the window's blue tint would otherwise fill it).
    @ViewBuilder func secondaryButtonStyle() -> some View {
        if #available(macOS 26, *), !GlassLook.plain {
            self.buttonStyle(.glass(.regular.interactive())).tint(nil)
        } else {
            self.buttonStyle(.bordered)
        }
    }
}

/// The app's colours: one strong blue on quiet paper, light and dark.
enum Palette {
    static let blue = Color(red: 0x08 / 255, green: 0x66 / 255, blue: 0xFF / 255)
    static let paper = dynamic(light: 0xF7F8FA, dark: 0x15181D)
    static let ink = dynamic(light: 0x232830, dark: 0xF2F4F7)
    static let muted = dynamic(light: 0x606C7C, dark: 0x9AA6B6)
    static let line = dynamic(light: 0xE2E6EC, dark: 0x2B323D)

    private static func dynamic(light: UInt32, dark: UInt32) -> Color {
        Color(nsColor: NSColor(name: nil) { appearance in
            let rgb = appearance.bestMatch(from: [.darkAqua, .aqua]) == .darkAqua ? dark : light
            return NSColor(srgbRed: CGFloat(rgb >> 16 & 0xFF) / 255, green: CGFloat(rgb >> 8 & 0xFF) / 255,
                           blue: CGFloat(rgb & 0xFF) / 255, alpha: 1)
        })
    }
}

/// Paper with a faint grid and a blue glow, behind a window's content, so the glass above
/// it has something to show.
struct WindowBackdrop: View {
    var body: some View {
        ZStack {
            Palette.paper
            Canvas { context, size in
                var grid = Path()
                let step: CGFloat = 28
                for x in stride(from: 0, through: size.width, by: step) { grid.addRect(CGRect(x: x, y: 0, width: 1, height: size.height)) }
                for y in stride(from: 0, through: size.height, by: step) { grid.addRect(CGRect(x: 0, y: y, width: size.width, height: 1)) }
                context.fill(grid, with: .color(Palette.line.opacity(0.55)))
            }
            .mask(RadialGradient(colors: [.black, .clear], center: .topLeading, startRadius: 0, endRadius: 700))
            RadialGradient(colors: [Palette.blue.opacity(0.28), .clear], center: .topLeading, startRadius: 0, endRadius: 520)
            RadialGradient(colors: [Palette.blue.opacity(0.12), .clear], center: .bottomTrailing, startRadius: 0, endRadius: 420)
        }
        .ignoresSafeArea()
    }
}

/// Castpane's icon, from the app bundle (the system's generic one under `swift run`).
struct AppMark: View {
    var size: CGFloat
    var body: some View {
        Image(nsImage: NSApp.applicationIconImage).resizable().interpolation(.high).frame(width: size, height: size)
            .accessibilityHidden(true)
    }
}
