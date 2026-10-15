import SwiftUI

/// How many accounts one backup selection may name. This is
/// transfer.MaxBackupAccounts: the sheet and the desktop protocol accept the
/// same set the backup file can hold.
enum BackupLimits {
  static let maxAccounts = 256
}

struct CreateBackupSheet: View {
  @ObservedObject var model: MacOSDesignModel
  @Environment(\.dismiss) private var dismiss
  @State private var selectedAccountIDs = Set<String>()

  private let selectionLimit = BackupLimits.maxAccounts

  private var savedAccounts: [DesignAccount] {
    model.accounts.filter { $0.kind == .saved }
  }

  var body: some View {
    DesignSheetHost(
      model: model,
      title: model.localized("desktop.backups.export_title"),
      width: 480,
      primaryTitle: model.localized("desktop.backups.export"),
      primaryDisabled: selectedAccountIDs.isEmpty,
      primaryIdentifier: "backup-create.confirm",
      cancelTitle: model.localized("desktop.backups.cancel"),
      cancelHelp: model.localized("desktop.backups.cancel_help"),
      onCancel: { dismiss() },
      onPrimary: {
        if model.createBackup(accountIDs: selectedAccountIDs) { dismiss() }
      }
    ) {
      Form {
        Section {
          if savedAccounts.isEmpty {
            DesignEmptyRow(text: model.localized("desktop.backups.no_saved_accounts"))
          }
          ForEach(savedAccounts) { account in
            Toggle(
              isOn: Binding(
                get: { selectedAccountIDs.contains(account.id) },
                set: { on in
                  if on, selectedAccountIDs.count < selectionLimit {
                    selectedAccountIDs.insert(account.id)
                  } else if !on {
                    selectedAccountIDs.remove(account.id)
                  }
                }
              )
            ) {
              Label {
                VStack(alignment: .leading, spacing: 2) {
                  Text(account.name)
                  Text(model.localizedSource(account.detail))
                    .foregroundStyle(.secondary)
                    .lineLimit(1)
                }
              } icon: {
                DesignProviderIcon(
                  provider: account.provider,
                  fallbackSymbol: account.symbol
                )
              }
            }
            .disabled(
              !selectedAccountIDs.contains(account.id)
                && selectedAccountIDs.count >= selectionLimit
            )
            .accessibilityIdentifier("backup-create.account.\(account.id)")
          }
        } header: {
          HStack {
            Text(model.localized("desktop.backups.saved_accounts"))
            Spacer()
            if savedAccounts.count > 1 {
              Button(
                model.localized(
                  selectedAccountIDs.count == savedAccounts.count
                    ? "desktop.backups.deselect_all" : "desktop.backups.select_all"
                )
              ) {
                if selectedAccountIDs.count == savedAccounts.count {
                  selectedAccountIDs.removeAll()
                } else {
                  selectedAccountIDs = Set(savedAccounts.prefix(selectionLimit).map(\.id))
                }
              }
              .help(
                model.localized(
                  selectedAccountIDs.count == savedAccounts.count
                    ? "desktop.backups.deselect_saved_help" : "desktop.backups.select_saved_help"
                )
              )
              .buttonStyle(.plain)
              .font(.caption)
              .foregroundStyle(Color.accentColor)
            }
          }
        } footer: {
          if savedAccounts.isEmpty {
            Text(model.localized("desktop.backups.add_login"))
          } else {
            Text(model.localized("desktop.backups.unencrypted"))
          }
        }
      }
      .onAppear {
        selectedAccountIDs = Set(savedAccounts.prefix(selectionLimit).map(\.id))
      }
    }
  }
}

struct RestoreBackupSheet: View {
  @ObservedObject var model: MacOSDesignModel
  let backupID: String
  var importedPackage = false
  @Environment(\.dismiss) private var dismiss
  @State private var selectedAccountIDs = Set<String>()
  @State private var confirmation: DesignConfirmation?

  private var backup: DesignBackup? { model.backups.first { $0.id == backupID } }

  private var duplicateCount: Int {
    (backup?.accounts ?? []).filter {
      selectedAccountIDs.contains($0.id) && alreadySaved($0)
    }.count
  }

  var body: some View {
    DesignSheetHost(
      model: model,
      title: model.localized(
        importedPackage ? "desktop.backups.import_title" : "desktop.backups.restore_title"
      ),
      width: 480,
      primaryTitle: primaryTitle,
      primaryDisabled: selectedAccountIDs.isEmpty || model.backupInspectionState == .importing,
      primaryIdentifier: "backup-restore.confirm",
      cancelTitle: model.localized("desktop.backups.cancel"),
      cancelHelp: model.localized("desktop.backups.cancel_help"),
      onCancel: { dismiss() },
      onPrimary: {
        if model.backupInspectionState == .success {
          dismiss()
          return
        }
        if model.backupInspectionState == .expired
          || model.backupInspectionState == .atomicFailure
        {
          if model.importBackupPackage() { dismiss() }
          return
        }
        if duplicateCount > 0 { requestDuplicateChoice() }
        else { restore(overwrite: false) }
      }
    ) {
      Form {
        if model.backupInspectionState != .idle && model.backupInspectionState != .ready {
          restoreOutcome
        }
        if let backup {
          Section {
            ForEach(backup.accounts) { account in
              Toggle(
                isOn: Binding(
                  get: { selectedAccountIDs.contains(account.id) },
                  set: { on in
                    if on { selectedAccountIDs.insert(account.id) }
                    else { selectedAccountIDs.remove(account.id) }
                  }
                )
              ) {
                Label {
                  VStack(alignment: .leading, spacing: 2) {
                    HStack(spacing: 6) {
                      Text(account.name)
                      if alreadySaved(account) {
                        Text(model.localized("desktop.backups.existing"))
                          .font(.caption2)
                          .foregroundStyle(.secondary)
                          .accessibilityLabel(model.localized("desktop.backups.already_saved"))
                      }
                    }
                    Text(model.localizedSource(account.detail))
                      .foregroundStyle(.secondary)
                      .lineLimit(1)
                  }
                } icon: {
                  DesignProviderIcon(
                    provider: account.provider,
                    fallbackSymbol: account.symbol
                  )
                }
              }
              .disabled(account.status == .unavailable)
              .accessibilityIdentifier("backup-restore.account.\(account.id)")
            }
          } header: {
            HStack {
              Text(model.localized("desktop.backups.accounts_in_backup"))
              Spacer()
              let available = backup.accounts.filter { $0.status != .unavailable }
              if available.count > 1 {
                Button(
                  model.localized(
                    selectedAccountIDs.count == available.count
                      ? "desktop.backups.deselect_all" : "desktop.backups.select_all"
                  )
                ) {
                  if selectedAccountIDs.count == available.count {
                    selectedAccountIDs.removeAll()
                  } else {
                    selectedAccountIDs = Set(available.map(\.id))
                  }
                }
                .help(
                  model.localized(
                    selectedAccountIDs.count == available.count
                      ? "desktop.backups.deselect_backup_help" : "desktop.backups.select_backup_help"
                  )
                )
                .buttonStyle(.plain)
                .font(.caption)
                .foregroundStyle(Color.accentColor)
              }
            }
          } footer: {
            Text(model.localized("desktop.backups.accounts_in_backup_help"))
          }
        }
      }
      .onAppear {
        selectedAccountIDs = Set(
          (backup?.accounts ?? []).filter { $0.status != .unavailable }.map(\.id)
        )
      }
      .designConfirmation($confirmation, model: model)
    }
  }

  /// The only confirmation with two answers: both restore the backup, they
  /// differ in what happens to an account AnyPick already holds. Cancel stays
  /// rightmost so Return still means "go back".
  private func requestDuplicateChoice() {
    confirmation = DesignConfirmation(
      id: "replace-existing-accounts",
      title: model.localized("desktop.backups.replace_existing_title"),
      message: String(
        format: model.localized(
          duplicateCount == 1
            ? "desktop.backups.duplicate_one" : "desktop.backups.duplicate_many"
        ),
        duplicateCount
      ),
      actions: [
        .confirm(model.localized("desktop.backups.skip"), destructive: false) {
          restore(overwrite: false)
        },
        .confirm(model.localized("desktop.backups.replace")) { restore(overwrite: true) },
      ]
    )
  }

  private func alreadySaved(_ account: DesignAccount) -> Bool {
    model.alreadySavedAccount(account)
  }

  private func restore(overwrite: Bool) {
    model.restoreBackup(id: backupID, accountIDs: selectedAccountIDs, overwrite: overwrite)
  }

  private var primaryTitle: String {
    switch model.backupInspectionState {
    case .success: model.localized("desktop.backups.done")
    case .expired, .atomicFailure: model.localized("desktop.backups.review_again_plain")
    default: model.localized("desktop.backups.import")
    }
  }

  @ViewBuilder
  private var restoreOutcome: some View {
    switch model.backupInspectionState {
    case .importing:
      Section {
        HStack(spacing: 8) {
          ProgressView()
            .controlSize(.small)
          Text(model.backupInspectionMessage ?? model.localized("desktop.backups.importing_accounts"))
            .foregroundStyle(.secondary)
        }
      }
    case .success:
      Section {
        Label(
          model.backupInspectionMessage ?? model.localized("desktop.backups.imported_title"),
          systemImage: "checkmark.circle.fill"
        )
          .foregroundStyle(.green)
      }
    case .expired:
      restoreIssue(
        title: model.localized("desktop.backups.expired_title"),
        message: model.backupInspectionMessage ?? model.localized("desktop.backups.expired_detail")
      )
    case .atomicFailure:
      restoreIssue(
        title: model.localized("desktop.backups.import_failed_title"),
        message: model.backupInspectionMessage ?? model.localized("desktop.backups.no_accounts_changed")
      )
    default:
      EmptyView()
    }
  }

  private func restoreIssue(title: String, message: String) -> some View {
    Section {
      Label {
        VStack(alignment: .leading, spacing: 2) {
          Text(title)
          Text(message)
            .foregroundStyle(.secondary)
        }
      } icon: {
        DesignWarningSymbol()
      }
    }
  }
}
