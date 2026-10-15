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
      model: model,
      title: account?.name ?? model.localized("desktop.account_detail.account"),
      width: 440,
      primaryTitle: model.localized("desktop.common.done"),
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
            .accessibilityLabel(
              accountAccessibilityLabel(for: account, in: model.accounts) { index, total in
                model.localized(
                  "desktop.accounts.position",
                  replacing: ["index": "\(index)", "total": "\(total)"]
                )
              }
            )
          }

          Section {
            LabeledContent(model.localized("desktop.account_detail.provider"), value: account.provider)
            LabeledContent(
              model.localized("desktop.account_detail.type"),
              value: model.localized(account.kind == .gateway ? "desktop.account_detail.api_gateway" : "desktop.account_detail.saved_login")
            )
            LabeledContent(model.localized("desktop.common.status")) {
              if model.isCurrentAccount(account) {
                Text(model.localized("desktop.common.current"))
                  .foregroundStyle(.secondary)
              } else {
                DesignStatusLabel(model: model, status: account.status)
              }
            }
            Button(model.localized("desktop.common.edit")) { editing = true }
              .help(model.localized("desktop.account_inspect.edit_help"))
              .accessibilityIdentifier("account-inspect.edit")
          }

          if !usageWindows.isEmpty {
            ForEach(usageGroups) { group in
              Section {
                ForEach(group.windows) { window in
                  Group {
                    if group.title != nil {
                      DesignQuotaView(model: model, window: window, showsLimitCard: true)
                    } else {
                      LabeledContent(localizedQuotaWindowLabel(window, using: model)) {
                        DesignQuotaView(model: model, window: window, isCompact: false, showsLabel: false)
                      }
                    }
                  }
                  .accessibilityIdentifier("account.usage.\(window.id)")
                }
              } header: {
                Text(group.title ?? model.localized("desktop.account_detail.remaining_quota"))
              } footer: {
                if group.id == usageGroups.last?.id {
                  Text(
                    model.localized("desktop.account_detail.reported_by_active", replacing: [
                      "provider": account.provider,
                    ])
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
