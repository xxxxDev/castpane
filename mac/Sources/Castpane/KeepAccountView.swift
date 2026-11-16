import SwiftUI

/// From this version Castpane keeps one account. With more than one admin account left from
/// an earlier version, the person at this Mac picks the one to keep; every other is deleted.
struct KeepAccountView: View {
    @EnvironmentObject var model: AppModel
    @ViewState private var accounts: [LocalAPI.Account] = []
    @ViewState private var chosen: String?
    @ViewState private var deleteCount = 0
    @ViewState private var loaded = false
    @ViewState private var busy = false
    @ViewState private var message = ""

    var body: some View {
        VStack(alignment: .leading, spacing: 14) {
            Label("Castpane now keeps one account", systemImage: "person.crop.circle.badge.exclamationmark").font(.title3.bold())
            Text("From this version, Castpane has one account: the one its setup assistant made. This Mac has \(accounts.count) admin accounts from an earlier version. Choose the one to keep; the others are deleted, with their sign-ins, passkeys and devices.")
                .fixedSize(horizontal: false, vertical: true)
            List(accounts) { a in
                HStack {
                    Image(systemName: chosen == a.id ? "largecircle.fill.circle" : "circle").foregroundStyle(Palette.blue)
                    VStack(alignment: .leading) {
                        Text(a.name.isEmpty ? a.username : a.name)
                        Text(a.username + (a.wizard ? " · made by the setup assistant" : "")).font(.caption).foregroundStyle(.secondary)
                    }
                    Spacer()
                }
                .contentShape(Rectangle())
                .onTapGesture { chosen = a.id }
            }
            .frame(minHeight: 140)
            if loaded && accounts.count < 2 {
                Text("Nothing to choose now: no more than one admin account can sign in.").foregroundStyle(.secondary).font(.callout)
            }
            if !message.isEmpty { Text(message).foregroundStyle(.red).font(.callout) }
            HStack {
                Spacer()
                Button("Later") { close() }
                Button("Keep this one…") { confirm() }.disabled(chosen == nil || busy || deleteCount == 0)
            }
        }
        .padding(20)
        .task { await load() }
    }

    /// This window, by its id: the call may take a while, and focus may move meanwhile.
    private var window: NSWindow? { NSApp.windows.first { $0.identifier?.rawValue == "keep-account" } }
    private func close() { window?.close() }

    /// Asked first, with Cancel as the default button: Return twice deletes nothing.
    private func confirm() {
        guard let id = chosen, let kept = accounts.first(where: { $0.id == id }) else { return }
        let alert = NSAlert()
        alert.alertStyle = .critical
        alert.messageText = "Delete the other accounts?"
        alert.informativeText = "Only \(kept.username) is kept. \(deleteCount) other account\(deleteCount == 1 ? " is" : "s are") deleted, with their sign-ins, passkeys and devices. This cannot be undone."
        alert.addButton(withTitle: "Cancel")
        let delete = alert.addButton(withTitle: "Delete")
        delete.hasDestructiveAction = true
        delete.keyEquivalent = ""
        let answer: (NSApplication.ModalResponse) -> Void = { r in if r == .alertSecondButtonReturn { keep() } }
        if let window { alert.beginSheetModal(for: window, completionHandler: answer) } else { answer(alert.runModal()) }
    }

    private func load() async {
        do {
            let got = try await model.api.accounts()
            accounts = got.list; deleteCount = got.deletes
            chosen = accounts.first { $0.wizard }?.id
            loaded = true
        } catch { message = error.localizedDescription }
    }

    private func keep() {
        guard let id = chosen else { return }
        busy = true
        Task {
            do {
                let left = try await model.api.keepAccount(id: id)
                model.refreshStatus()
                if left > 0 {
                    message = "\(left) account\(left == 1 ? " was" : "s were") not fully removed. Castpane finishes \(left == 1 ? "it" : "them") at its next start, or press Keep again."
                    if let got = try? await model.api.accounts() { accounts = got.list; deleteCount = got.deletes }
                } else {
                    close()
                }
            } catch { message = error.localizedDescription }
            busy = false
        }
    }
}
