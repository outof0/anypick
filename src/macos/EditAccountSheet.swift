import SwiftUI

struct EditAccountSheet: View {
  @ObservedObject var model: MacOSDesignModel
  let accountID: String
  @Environment(\.dismiss) private var dismiss
  @State private var name = ""
  /// Production edit waits for the engine result like the add sheet.
  @State private var awaitingSaveResult = false
  @State private var saveError: String?
  @FocusState private var nameFocused: Bool

  private var account: DesignAccount? { model.accounts.first { $0.id == accountID } }

  private var canSave: Bool {
    let cleaned = name.trimmingCharacters(in: .whitespacesAndNewlines)
    return !cleaned.isEmpty && cleaned != account?.name
  }

  var body: some View {
    DesignSheetHost(
      model: model,
      title: model.localized("desktop.account_detail.edit_account"),
      width: 440,
      primaryTitle: model.localized("desktop.common.save"),
      primaryDisabled: !canSave || model.isBusy || awaitingSaveResult,
      primaryIdentifier: "account-edit.save",
      onCancel: { dismiss() },
      onPrimary: save
    ) {
      Form {
        if let account {
          Section {
            HStack(spacing: 12) {
              DesignProviderIcon(
                provider: account.provider,
                fallbackSymbol: account.symbol,
                size: 30
              )
              VStack(alignment: .leading, spacing: 3) {
                Text(disambiguatedAccountName(for: account, in: model.accounts))
                  .font(.headline)
              Text(account.detail.isEmpty ? model.localized("desktop.account_detail.identity_not_reported") : account.detail)
                  .foregroundStyle(.secondary)
                  .lineLimit(1)
              }
              Spacer(minLength: 0)
            }
          } header: {
            Text(model.localized("desktop.account_detail.account"))
          }

          Section {
            TextField(model.localized("desktop.account_detail.name"), text: $name, prompt: Text(model.localized("desktop.account_detail.name_example")))
              .focused($nameFocused)
              .accessibilityIdentifier("account-edit.name")
            LabeledContent(model.localized(account.kind == .gateway ? "desktop.account_detail.endpoint" : "desktop.account_detail.email_or_id")) {
              Text(account.detail.isEmpty ? model.localized("desktop.account_detail.not_reported") : account.detail)
                .foregroundStyle(.secondary)
                .textSelection(.enabled)
            }
            LabeledContent(model.localized("desktop.account_detail.provider"), value: account.provider)
            LabeledContent(
              model.localized("desktop.account_detail.type"),
              value: model.localized(account.kind == .gateway ? "desktop.account_detail.api_gateway" : "desktop.account_detail.saved_login")
            )
            LabeledContent(model.localized("desktop.common.status")) {
              if model.isCurrentAccount(account) {
                Label(model.localized("desktop.common.current"), systemImage: "checkmark.circle.fill")
                  .foregroundStyle(.green)
              } else {
                Label(account.status.localizedLabel(using: model), systemImage: account.status.symbol)
                  .foregroundStyle(account.status.color)
              }
            }
          } header: {
            Text(model.localized("desktop.account_detail.details"))
          } footer: {
            Text(model.localized("desktop.account_detail.name_help"))
          }

          if let saveError {
            Section {
              Label {
                Text(saveError)
                  .font(.subheadline)
                  .foregroundStyle(.secondary)
                  .fixedSize(horizontal: false, vertical: true)
              } icon: {
                Image(systemName: "exclamationmark.triangle.fill")
                  .foregroundStyle(.orange)
              }
            }
            .accessibilityIdentifier("account-edit.error")
          }
        } else {
          ContentUnavailableView(
            model.localized("desktop.account_detail.account_unavailable"),
            systemImage: "person.crop.circle.badge.exclamationmark",
            description: Text(model.localized("desktop.account_detail.remove_unavailable"))
          )
        }
      }
      .onAppear {
        name = account?.name ?? ""
        nameFocused = true
      }
      .onChange(of: model.operationResult) { _, result in
        guard awaitingSaveResult,
          result?.operation == "account-edit" || result?.operation == "gateway-edit"
        else { return }
        awaitingSaveResult = false
        if result?.succeeded == true {
          dismiss()
        } else if let message = result?.message, !message.isEmpty {
          saveError = displaySafeFeedback(
            message,
            fallback: model.localized("desktop.account_detail.save_error_safe")
          )
        } else {
          saveError = model.localized("desktop.account_detail.save_error")
        }
      }
    }
  }

  private func save() {
    saveError = nil
    if model.isProduction {
      // No mutation fires for a vanished account — never strand the sheet
      // waiting for a result that cannot arrive.
      guard model.accounts.contains(where: { $0.id == accountID }) else {
        saveError = model.localized("desktop.account_detail.remove_unavailable")
        return
      }
      // Only arm the wait after the request is accepted; otherwise the sheet
      // would wait for a result that cannot arrive.
      guard !model.isBusy else {
        saveError = model.localized("desktop.account_detail.change_in_progress")
        return
      }
      if model.updateAccount(id: accountID, label: name) {
        awaitingSaveResult = true
      } else {
        saveError = model.localized("desktop.account_detail.change_in_progress")
      }
      return
    }
    model.updateAccount(id: accountID, label: name)
    dismiss()
  }
}
