import SwiftUI
import CastpaneCore

/// What a check found, and the update's install.
struct UpdateView: View {
    @EnvironmentObject var model: AppModel
    @EnvironmentObject var updater: Updater

    var body: some View {
        VStack(alignment: .leading, spacing: 14) {
            HStack(spacing: 12) {
                AppMark(size: 44)
                VStack(alignment: .leading, spacing: 2) {
                    Text(title).font(.title2.bold())
                    Text("This Mac has Castpane \(Updater.currentVersion).").foregroundStyle(.secondary)
                }
            }
            content
            Spacer(minLength: 0)
            HStack {
                if case .available(let u) = updater.state, let page = URL(string: u.page), !u.page.isEmpty {
                    Link("Release Notes on GitHub", destination: page)
                }
                Spacer()
                buttons
            }
        }
        .padding(.horizontal, 24)
        .padding(.top, 34)
        .padding(.bottom, 20)
        .frame(width: 520, height: 420)
        .background(WindowBackdrop())
    }

    private var title: String {
        switch updater.state {
        case .available(let u): return "Castpane \(u.version) is available"
        case .upToDate: return "Castpane is up to date"
        case .checking: return "Checking for updates…"
        case .working: return "Updating Castpane"
        case .failed: return "Update"
        case .idle: return "Updates"
        }
    }

    @ViewBuilder private var content: some View {
        switch updater.state {
        case .available(let u):
            VStack(alignment: .leading, spacing: 10) {
                if u.prerelease { Label("A beta version.", systemImage: "flask").font(.callout).foregroundStyle(.secondary) }
                ScrollView {
                    NotesView(markdown: u.notes)
                        .frame(maxWidth: .infinity, alignment: .leading)
                }
                .frame(maxHeight: 170)
                .glassCard(padding: 12)
                if model.viewerConnected {
                    Label("Installing restarts Castpane: the viewer connected now is disconnected.", systemImage: "exclamationmark.triangle")
                        .font(.callout).foregroundStyle(.orange)
                }
                if let reason = Updater.cannotUpdate {
                    Text(reason).font(.callout).foregroundStyle(.red).fixedSize(horizontal: false, vertical: true)
                }
            }
        case .working(let step):
            HStack(spacing: 10) { ProgressView().controlSize(.small); Text(step) }
        case .failed(let message):
            Text(message).foregroundStyle(.red).fixedSize(horizontal: false, vertical: true)
        case .upToDate:
            Text(updater.lastChecked.map { "Checked \($0.formatted(date: .abbreviated, time: .shortened))." } ?? "")
                .foregroundStyle(.secondary)
        case .checking:
            ProgressView().controlSize(.small)
        case .idle:
            EmptyView()
        }
    }

    @ViewBuilder private var buttons: some View {
        switch updater.state {
        case .available(let u):
            Button("Later") { Windows.shared.close("update") }.secondaryButtonStyle()
            Button("Install and Restart") { Task { await updater.install(u) } }
                .primaryButtonStyle().keyboardShortcut(.defaultAction)
                .disabled(Updater.cannotUpdate != nil)
        case .working:
            EmptyView()
        default:
            Button("Check Again") { model.checkForUpdates() }.secondaryButtonStyle()
            Button("Done") { Windows.shared.close("update") }.primaryButtonStyle().keyboardShortcut(.defaultAction)
        }
    }
}

/// The release's notes, laid out: headings, bullets, paragraphs, code (ReleaseNotes).
private struct NotesView: View {
    let markdown: String

    private func inline(_ s: String) -> Text {
        let a = (try? AttributedString(markdown: s, options: .init(interpretedSyntax: .inlineOnlyPreservingWhitespace))) ?? AttributedString(s)
        return Text(a)
    }

    var body: some View {
        let blocks = ReleaseNotes.blocks(markdown)
        VStack(alignment: .leading, spacing: 6) {
            if blocks.isEmpty { Text("No notes for this release.").foregroundStyle(.secondary) }
            ForEach(Array(blocks.enumerated()), id: \.offset) { _, block in
                switch block {
                case .heading(let s): inline(s).font(.callout.bold()).padding(.top, 4)
                case .bullet(let s):
                    HStack(alignment: .firstTextBaseline, spacing: 6) { Text("•"); inline(s).fixedSize(horizontal: false, vertical: true) }
                case .paragraph(let s): inline(s).fixedSize(horizontal: false, vertical: true)
                case .code(let s): Text(s).font(.system(.caption, design: .monospaced)).foregroundStyle(.secondary)
                }
            }
        }
        .font(.callout)
        .textSelection(.enabled)
    }
}
