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
              Text(account.detail.isEmpty ? model.localized("desktop.account_detail.identity_not_reported") : account.detail)
                .foregroundStyle(.secondary)
                .lineLimit(1)
            }
            Spacer(minLength: 12)
            accountStatus(account)
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
        } header: {
          Text(model.localized("desktop.account_detail.account"))
        }

        if account.status == .attention || account.status == .unavailable {
          Section {
            Label {
              VStack(alignment: .leading, spacing: 2) {
                Text(model.localized("desktop.common.needs_attention"))
                  .fontWeight(.medium)
                Text(account.status.localizedLabel(using: model))
                  .font(.subheadline)
                  .foregroundStyle(.secondary)
              }
            } icon: {
              DesignWarningSymbol(scale: .medium)
            }
          }
        }

        Section {
          LabeledContent(model.localized(account.kind == .gateway ? "desktop.account_detail.endpoint" : "desktop.account_detail.email_or_id")) {
            Text(account.detail.isEmpty ? model.localized("desktop.account_detail.not_reported") : account.detail)
              .foregroundStyle(account.detail.isEmpty ? .secondary : .primary)
              .textSelection(.enabled)
          }
          LabeledContent(model.localized("desktop.account_detail.provider"), value: account.provider)
          LabeledContent(
            model.localized("desktop.account_detail.type"),
            value: model.localized(account.kind == .gateway ? "desktop.account_detail.api_gateway" : "desktop.account_detail.saved_login")
          )
          LabeledContent(model.localized("desktop.account_detail.account_name"), value: account.name)
          LabeledContent(
            model.localized("desktop.account_detail.last_used"),
            value: model.localizedSource(account.lastUsed)
          )
        } header: {
          Text(model.localized("desktop.account_detail.identity"))
        }

        if model.showUsage {
          if usageWindows.isEmpty {
            Section {
              VStack(alignment: .leading, spacing: 8) {
                Text(
                  model.isCurrentAccount(account)
                    ? model.localized("desktop.account_detail.provider_no_quota")
                    : model.localized("desktop.account_detail.live_quota_active")
                )
                .foregroundStyle(.secondary)
                .fixedSize(horizontal: false, vertical: true)

                if account.kind == .saved && !model.isCurrentAccount(account) {
                  Button(model.localized("desktop.account_detail.make_current_check_quota")) {
                    model.makeAccountCurrent(id: account.id)
                  }
                  .buttonStyle(.bordered)
                  .controlSize(.small)
                  .help(model.localized("desktop.account_detail.make_current_check_quota_help"))
                  .disabled(model.isBusy)
                }
              }
            } header: {
              Text(model.localized("desktop.account_detail.remaining_quota"))
            } footer: {
              Text(
                model.isCurrentAccount(account)
                  ? model.localized("desktop.account_detail.reported_by_active", replacing: ["provider": account.provider])
                  : model.localized("desktop.account_detail.usage_active")
              )
            }
          } else {
            ForEach(usageGroups) { group in
              Section {
                ForEach(group.windows) { window in
                  usageRow(window, grouped: group.title != nil)
                }
              } header: {
                Text(group.title ?? model.localized("desktop.account_detail.remaining_quota"))
              } footer: {
                if group.id == usageGroups.last?.id {
                  Text(
                    model.isCurrentAccount(account)
                      ? model.localized("desktop.account_detail.reported_by_active", replacing: ["provider": account.provider])
                      : model.localized("desktop.account_detail.usage_active")
                  )
                }
              }
            }
          }
        }
      }
    }
    .navigationTitle(account?.name ?? model.localized("desktop.account_detail.account"))
    .sheet(isPresented: $editing) {
      EditAccountSheet(model: model, accountID: accountID)
    }
    .designConfirmation($confirmation, model: model)
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
      Label(model.localized("desktop.common.current"), systemImage: "checkmark.circle.fill")
        .foregroundStyle(.green)
        .labelStyle(.titleAndIcon)
    } else {
      Label(account.status.localizedLabel(using: model), systemImage: account.status.symbol)
        .foregroundStyle(account.status.color)
        .labelStyle(.titleAndIcon)
    }
  }

  private func detailActions(for account: DesignAccount) -> some View {
    DesignPaneActions {
      DesignSheetButton(title: model.localized("desktop.common.edit")) { editing = true }
      if account.kind == .saved && !model.isCurrentAccount(account) {
        DesignSheetButton(
          title: model.localized("desktop.accounts.switch_account"),
          enabled: !model.isBusy,
          identifier: "accounts.inspector.make-current"
        ) { model.makeAccountCurrent(id: account.id) }
      }
      DesignSheetButton(
        title: model.localized(account.kind == .gateway ? "desktop.common.test_connection" : "desktop.common.refresh_login"),
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
        title: model.localized("desktop.account_detail.remove_account"),
        enabled: !model.isBusy,
        destructive: true,
        identifier: "accounts.inspector.remove"
      ) { requestRemoval() }
    }
  }

  private func requestRemoval() {
    confirmation = DesignConfirmation(
      id: "remove-account",
      title: account.map { model.localized("desktop.account_detail.remove_title", replacing: ["name": $0.name]) } ?? model.localized("desktop.account_detail.remove_account_title"),
      message: removalMessage,
      action: .confirm(model.localized("desktop.common.remove")) {
        removalRequested = true
        model.removeAccount(id: accountID)
      }
    )
  }

  private func usageRow(_ window: DesignUsageWindow, grouped: Bool) -> some View {
    Group {
      LabeledContent(localizedQuotaWindowLabel(window, using: model)) {
        DesignQuotaView(model: model, window: window, isCompact: false, showsLabel: false)
      }
    }
    .accessibilityIdentifier("accounts.inspector.usage.\(window.id)")
  }

  private var removalMessage: String {
    guard let account else {
      return model.localized("desktop.account_detail.remove_unavailable")
    }
    if account.kind == .gateway {
      return model.localized("desktop.account_detail.remove_gateway_message", replacing: ["name": account.name])
    }
    let app = anypickDisplayName(account.provider)
    if model.isCurrentAccount(account) {
      return model.localized("desktop.account_detail.remove_current_message", replacing: ["name": account.name, "app": app])
    }
    return model.localized("desktop.account_detail.remove_other_message", replacing: ["name": account.name, "app": app])
  }
}
