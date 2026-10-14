import SwiftUI

struct AccountDetailView: View {
  @ObservedObject var model: MacOSDesignModel
  let accountID: String
  @State private var editing = false
  @State private var confirmation: DesignConfirmation?
  @State private var removalRequested = false
  @Environment(\.dismiss) private var dismiss

  private var account: DesignAccount? { model.accounts.first { $0.id == accountID } }
  private var usageWindows: [DesignUsageWindow] {
    guard let account else { return [] }
    return model.usageWindows(for: account)
  }
  private var usageGroups: [DesignUsageGroup] { groupUsageWindows(usageWindows) }

  var body: some View {
    DesignGroupedPane(
      actions: {
        if let account { detailActions(for: account) }
      }
    ) {
      if let account {
        Section {
          HStack(spacing: 12) {
            DesignProviderIcon(
              provider: account.provider,
              fallbackSymbol: account.symbol,
              size: 32
            )
            VStack(alignment: .leading, spacing: 3) {
              Text(disambiguatedAccountName(for: account, in: model.accounts))
                .font(.headline)
              Text(account.detail.isEmpty ? "Identity not reported" : account.detail)
                .foregroundStyle(.secondary)
                .lineLimit(1)
            }
            Spacer(minLength: 12)
            accountStatus(account)
          }
          .accessibilityElement(children: .combine)
          .accessibilityLabel(accountAccessibilityLabel(for: account, in: model.accounts))
        } header: {
          Text("Account")
        }

        if account.status == .attention || account.status == .unavailable {
          Section {
            Label {
              VStack(alignment: .leading, spacing: 2) {
                Text("Needs Attention")
                  .fontWeight(.medium)
                Text(account.status.rawValue)
                  .font(.subheadline)
                  .foregroundStyle(.secondary)
              }
            } icon: {
              DesignWarningSymbol(scale: .medium)
            }
          }
        }

        Section {
          LabeledContent(account.kind == .gateway ? "Endpoint" : "Email or ID") {
            Text(account.detail.isEmpty ? "Not reported" : account.detail)
              .foregroundStyle(account.detail.isEmpty ? .secondary : .primary)
              .textSelection(.enabled)
          }
          LabeledContent("Provider", value: account.provider)
          LabeledContent(
            "Type",
            value: account.kind == .gateway ? "API Gateway" : "Saved Login"
          )
          LabeledContent("Account Name", value: account.name)
          LabeledContent("Last Used", value: account.lastUsed)
        } header: {
          Text("Identity")
        }

        if model.showUsage {
          if usageWindows.isEmpty {
            Section {
              VStack(alignment: .leading, spacing: 8) {
                Text(
                  model.isCurrentAccount(account)
                    ? "This provider does not report remaining quota."
                    : "Live quota is reported for the account currently active on this Mac."
                )
                .foregroundStyle(.secondary)
                .fixedSize(horizontal: false, vertical: true)

                if account.kind == .saved && !model.isCurrentAccount(account) {
                  Button("Make Current to Check Quota") {
                    model.makeAccountCurrent(id: account.id)
                  }
                  .buttonStyle(.bordered)
                  .controlSize(.small)
                  .help("Temporarily use this saved login on this Mac so AnyPick can read its quota.")
                  .disabled(model.isBusy)
                }
              }
            } header: {
              Text("Remaining Quota")
            } footer: {
              Text(
                model.isCurrentAccount(account)
                  ? "Reported by \(account.provider) for the account currently active on this Mac."
                  : "Usage is available for the account currently active on this Mac."
              )
            }
          } else {
            ForEach(usageGroups) { group in
              Section {
                ForEach(group.windows) { window in
                  usageRow(window, grouped: group.title != nil)
                }
              } header: {
                Text(group.title ?? "Remaining Quota")
              } footer: {
                if group.id == usageGroups.last?.id {
                  Text(
                    model.isCurrentAccount(account)
                      ? "Reported by \(account.provider) for the account currently active on this Mac."
                      : "Usage is available for the account currently active on this Mac."
                  )
                }
              }
            }
          }
        }
      }
    }
    .navigationTitle(account?.name ?? "Account")
    .sheet(isPresented: $editing) {
      EditAccountSheet(model: model, accountID: accountID)
    }
    .designConfirmation($confirmation)
    .onChange(of: model.accounts) { _, accounts in
      if removalRequested, !accounts.contains(where: { $0.id == accountID }) {
        dismiss()
      }
    }
    .onChange(of: model.isBusy) { wasBusy, busy in
      if removalRequested, wasBusy, !busy, account != nil {
        removalRequested = false
      }
    }
  }

  @ViewBuilder
  private func accountStatus(_ account: DesignAccount) -> some View {
    if model.isCurrentAccount(account) {
      Label("Current", systemImage: "checkmark.circle.fill")
        .foregroundStyle(.green)
        .labelStyle(.titleAndIcon)
    } else {
      Label(account.status.rawValue, systemImage: account.status.symbol)
        .foregroundStyle(account.status.color)
        .labelStyle(.titleAndIcon)
    }
  }

  private func detailActions(for account: DesignAccount) -> some View {
    DesignPaneActions {
      DesignSheetButton(title: "Edit…") { editing = true }
      if account.kind == .saved && !model.isCurrentAccount(account) {
        DesignSheetButton(
          title: "Make Current",
          enabled: !model.isBusy,
          identifier: "accounts.inspector.make-current"
        ) { model.makeAccountCurrent(id: account.id) }
      }
      DesignSheetButton(
        title: account.kind == .gateway ? "Test Connection" : "Refresh Login",
        enabled: !model.isBusy,
        identifier: "accounts.inspector.test"
      ) {
        if account.kind == .gateway {
          model.testSavedGateway(id: account.id)
        } else {
          model.refreshAccount(id: account.id)
        }
      }
      DesignSheetButton(
        title: "Remove Account…",
        enabled: !model.isBusy,
        destructive: true,
        identifier: "accounts.inspector.remove"
      ) { requestRemoval() }
    }
  }

  private func requestRemoval() {
    confirmation = DesignConfirmation(
      id: "remove-account",
      title: account.map { "Remove “\($0.name)” from AnyPick?" } ?? "Remove Account?",
      message: removalMessage,
      action: .confirm("Remove") {
        removalRequested = true
        model.removeAccount(id: accountID)
      }
    )
  }

  private func usageRow(_ window: DesignUsageWindow, grouped: Bool) -> some View {
    Group {
      if grouped {
        DesignQuotaView(window: window, showsLimitCard: true)
      } else {
        LabeledContent(quotaWindowLabel(window)) {
          DesignQuotaView(window: window, isCompact: false, showsLabel: false)
        }
      }
    }
    .accessibilityIdentifier("accounts.inspector.usage.\(window.id)")
  }

  private var removalMessage: String {
    guard let account else {
      return "This account will no longer be available in AnyPick."
    }
    if account.kind == .gateway {
      return "Only “\(account.name)” is removed from AnyPick. The remote API key is not revoked."
    }
    let app = anypickDisplayName(account.provider)
    if model.isCurrentAccount(account) {
      return "“\(account.name)” is removed from AnyPick. \(app) stays signed in on this Mac."
    }
    return "“\(account.name)” is removed from AnyPick. The \(app) login on this Mac does not change."
  }
}
