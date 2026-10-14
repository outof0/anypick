import SwiftUI

struct AccountInspectSheet: View {
  @ObservedObject var model: MacOSDesignModel
  let accountID: String
  @Environment(\.dismiss) private var dismiss
  @State private var editing = false

  private var account: DesignAccount? { model.accounts.first { $0.id == accountID } }
  private var usageWindows: [DesignUsageWindow] {
    guard let account else { return [] }
    return model.usageWindows(for: account)
  }
  private var usageGroups: [DesignUsageGroup] { groupUsageWindows(usageWindows) }

  var body: some View {
    DesignSheetHost(
      title: account?.name ?? "Account",
      width: 440,
      primaryTitle: "Done",
      primaryIdentifier: "account-inspect.done",
      showsCancel: false,
      onCancel: { dismiss() },
      onPrimary: { dismiss() }
    ) {
      Form {
        if let account {
          Section {
            Label {
              VStack(alignment: .leading, spacing: 2) {
                Text(disambiguatedAccountName(for: account, in: model.accounts))
                let identity = accountIdentityLine(provider: account.provider, detail: account.detail)
                if !identity.isEmpty {
                  Text(identity)
                    .foregroundStyle(.secondary)
                }
              }
            } icon: {
              DesignProviderIcon(provider: account.provider, fallbackSymbol: account.symbol)
            }
            .accessibilityElement(children: .combine)
            .accessibilityLabel(accountAccessibilityLabel(for: account, in: model.accounts))
          }

          Section {
            LabeledContent("Provider", value: account.provider)
            LabeledContent("Type", value: account.kind == .gateway ? "API Gateway" : "Saved Login")
            LabeledContent("Status") {
              if model.isCurrentAccount(account) {
                Text("Current")
                  .foregroundStyle(.secondary)
              } else {
                DesignStatusLabel(status: account.status)
              }
            }
            Button("Edit…") { editing = true }
              .help("Change this account’s name or saved settings.")
              .accessibilityIdentifier("account-inspect.edit")
          }

          if !usageWindows.isEmpty {
            ForEach(usageGroups) { group in
              Section {
                ForEach(group.windows) { window in
                  Group {
                    if group.title != nil {
                      DesignQuotaView(window: window, showsLimitCard: true)
                    } else {
                      LabeledContent(quotaWindowLabel(window)) {
                        DesignQuotaView(window: window, isCompact: false, showsLabel: false)
                      }
                    }
                  }
                  .accessibilityIdentifier("account.usage.\(window.id)")
                }
              } header: {
                Text(group.title ?? "Remaining Quotas")
              } footer: {
                if group.id == usageGroups.last?.id {
                  Text(
                    "Reported by \(account.provider) for the account currently active on this Mac."
                  )
                }
              }
            }
          }
        }
      }
    }
    .sheet(isPresented: $editing) {
      EditAccountSheet(model: model, accountID: accountID)
    }
  }
}
