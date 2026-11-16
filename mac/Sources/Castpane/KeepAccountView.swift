import SwiftUI

/// From this version Castpane keeps one account. With more than one admin account left from
/// an earlier version, the person at this Mac picks the one to keep; every other is deleted.
struct KeepAccountView: View {
    @EnvironmentObject var model: AppModel
    @ViewState private var accounts: [LocalAPI.Account] = []
    @ViewState private var chosen: String?
    @ViewState private var asking = false
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
            if !message.isEmpty { Text(message).foregroundStyle(.red).font(.callout) }
            HStack {
                Spacer()
                Button("Later") { NSApp.keyWindow?.close() }
                Button("Keep this one") { asking = true }.keyboardShortcut(.defaultAction).disabled(chosen == nil || busy)
            }
        }
        .padding(20)
        .task { await load() }
        .alert("Delete the other accounts?", isPresented: $asking) {
            Button("Delete", role: .destructive) { keep() }
            Button("Cancel", role: .cancel) {}
        } message: {
            Text("Every account but \(accounts.first { $0.id == chosen }?.username ?? "") is deleted. This cannot be undone.")
        }
    }

    private func load() async {
        do {
            accounts = try await model.api.accounts()
            chosen = accounts.first { $0.wizard }?.id
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
                    accounts = (try? await model.api.accounts()) ?? accounts
                } else {
                    NSApp.keyWindow?.close()
                }
            } catch { message = error.localizedDescription }
            busy = false
        }
    }
}
