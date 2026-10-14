import SwiftUI

struct BackupPresentation: Identifiable, Equatable {
  let id: String
  let importedPackage: Bool
}

/// Startup-flow (ANYPICK_MACOS_FLOW) sheet presentation shared by Accounts
/// and Backups, so both panes present the same way.
enum DesignStartupFlow {
  /// Wait for the NavigationSplitView/NavigationStack host's first layout
  /// pass; a sheet set during construction is ignored by AppKit.
  static let presentationDelay: TimeInterval = 0.25
  static let accountsFlows: Set<String> = [
    "add-account", "add-account-error", "add-gateway", "add-gateway-error", "remove-account",
  ]
  static let backupsFlows: Set<String> = ["create-backup", "restore-backup", "import-backup"]
}

/// The pane's single sheet slot.
enum BackupSheet: Identifiable, Equatable {
  case create
  case review(BackupPresentation)

  var id: String {
    switch self {
    case .create: "create"
    case .review(let p): "review-\(p.id)-\(p.importedPackage)"
    }
  }
}

/// The sheet a startup flow opens: create-backup, restore-backup, or
/// import-backup (`ANYPICK_MACOS_FLOW`).
func backupStartupSheet(flow: String?, backups: [DesignBackup]) -> BackupSheet? {
  if flow == "create-backup" { return .create }
  return backupStartupPresentation(flow: flow, backups: backups).map { .review($0) }
}

/// The Restore/Import sheet a startup flow (`ANYPICK_MACOS_FLOW=restore-backup`
/// or `import-backup`) should open, or nil. Pure so it is unit-tested.
func backupStartupPresentation(flow: String?, backups: [DesignBackup]) -> BackupPresentation? {
  switch flow {
  case "import-backup":
    let id = backups.first(where: { $0.id == "backup-import" })?.id ?? backups.last?.id
    return id.map { BackupPresentation(id: $0, importedPackage: true) }
  case "restore-backup":
    return backups.first.map { BackupPresentation(id: $0.id, importedPackage: false) }
  default:
    return nil
  }
}

struct BackupsView: View {
  @ObservedObject var model: MacOSDesignModel
  /// One sheet slot for the pane (create, restore, import).
  @State private var activeSheet: BackupSheet?
  @State private var confirmation: DesignConfirmation?
  @State private var consumedInitialFlow = false

  var body: some View {
    DesignGroupedPane(actions: { paneActions }) {
      backupInspectionSection

      Section {
        Label {
          VStack(alignment: .leading, spacing: 3) {
            Text("Backup files contain working credentials")
              .font(.body.weight(.medium))
            Text("They are readable JSON and are not encrypted. Store them securely and don’t share them.")
              .font(.subheadline)
              .foregroundStyle(.secondary)
          }
        } icon: {
          DesignWarningSymbol(scale: .medium)
        }
      }

      Section {
        if model.backups.isEmpty {
          DesignEmptyRow(
            text: "No reviewed backups. Choose a backup file to review it before importing."
          )
        } else {
          ForEach(model.backups) { backup in
            LabeledContent {
              HStack(spacing: 8) {
                Button("Review") {
                  // Backups born in this list are restored, not imported:
                  // only a package picked via Choose/pendingImport carries
                  // importedPackage: true (presentImportedBackup).
                  activeSheet = .review(BackupPresentation(id: backup.id, importedPackage: false))
                }
                .controlSize(.small)
                .buttonStyle(.bordered)
                .help("Open this saved backup and review the accounts it contains.")

                DesignMoreActionsMenu(
                  label: "More backup options",
                  identifier: "backups.more.\(backup.id)"
                ) {
                  Button("Review Backup…") {
                    activeSheet = .review(BackupPresentation(id: backup.id, importedPackage: false))
                  }
                  .help("Review the accounts in this backup before importing.")
                  Button("Copy File Path") {
                    copyLocation(backup.location)
                  }
                  .help("Copy the backup’s full file path.")
                  Divider()
                  Button("Forget Review…", role: .destructive) {
                    requestForget(backup)
                  }
                  .help("Forget this review and discard its staged copy.")
                }
                .fixedSize()

                Image(systemName: "chevron.right")
                  .font(.system(size: 12, weight: .medium))
                  .foregroundStyle(.tertiary)
                  .accessibilityHidden(true)
              }
            } label: {
              Label {
                VStack(alignment: .leading, spacing: 2) {
                  Text(backup.createdAt)
                    .font(.body.weight(.medium))
                  Text(backupSubtitle(for: backup))
                    .font(.subheadline)
                    .foregroundStyle(.secondary)
                    .lineLimit(1)
                }
              } icon: {
                Image(systemName: "externaldrive.badge.checkmark")
                  .symbolRenderingMode(.hierarchical)
                  .foregroundStyle(Color.accentColor)
              }
            }
            .contextMenu {
              Button("Review Backup…") {
                activeSheet = .review(BackupPresentation(id: backup.id, importedPackage: false))
              }
              .help("Review the accounts in this backup before importing.")
              Button("Copy File Path") {
                copyLocation(backup.location)
              }
              .help("Copy the backup’s full file path.")
              Divider()
              Button("Forget Review…", role: .destructive) {
                requestForget(backup)
              }
              .help("Forget this review and discard its staged copy.")
            }
            .accessibilityIdentifier("backups.inventory.\(backup.id)")
          }
        }
      } header: {
        Text("Reviewed Backups")
      } footer: {
        // Saved accounts only, and forgetting also discards the staged server
        // copy; TTL remains the backstop if the forget frame is lost.
        Text(
          "Saved accounts only. API gateways, app settings, activity, and AnyPick settings are not included. For imported files, AnyPick stages a protected copy that is discarded when you forget the review."
        )
      }
    }
    .sheet(item: $activeSheet, onDismiss: consumeStartupFlow) { sheet in
      switch sheet {
      case .create:
        CreateBackupSheet(model: model)
      case .review(let presentation):
        RestoreBackupSheet(
          model: model,
          backupID: presentation.id,
          importedPackage: presentation.importedPackage
        )
      }
    }
    .onChange(of: model.pendingImportBackupID) { _, id in
      if id != nil { presentImportedBackup() }
    }
    .designConfirmation($confirmation)
    .onAppear {
      // Same mechanism as AccountsView's startup sheets (add-account,
      // add-gateway): read the flow from the model on appear, present after
      // DesignStartupFlow.presentationDelay while the flow is still pending,
      // and clear it only when the sheet is dismissed. The old code captured
      // the flow in init-time @State and cleared model.pendingStartupFlow
      // synchronously here, so any re-created BackupsView (or the publish
      // that clearing triggers) saw no flow and the sheet never appeared.
      guard !consumedInitialFlow, let flow = model.pendingStartupFlow else { return }
      consumedInitialFlow = true
      DispatchQueue.main.asyncAfter(deadline: .now() + DesignStartupFlow.presentationDelay) {
        guard model.pendingStartupFlow == flow else { return }
        if let target = backupStartupSheet(flow: flow, backups: model.backups) {
          if activeSheet == nil { activeSheet = target }
        } else if flow == "import-backup" {
          // No staged backup to show: honor the request with the file picker
          // (importBackupPackage consumes the pending flow itself).
          chooseBackup()
        }
      }
    }
  }

  private func consumeStartupFlow() {
    if DesignStartupFlow.backupsFlows.contains(model.pendingStartupFlow ?? "") {
      model.pendingStartupFlow = nil
    }
  }

  private func copyLocation(_ location: String) {
    if model.pasteString(location) {
      model.announceOnly("Copied backup file path.")
    } else {
      model.announceOnly("Couldn’t copy backup file path.")
    }
  }

  private func requestForget(_ backup: DesignBackup) {
    confirmation = DesignConfirmation(
      id: "forget-backup-review",
      title: "Forget This Backup Review?",
      message:
        "AnyPick discards this review and its staged copy. The original backup file is not deleted.",
      action: .confirm("Forget") { model.deleteBackup(id: backup.id) }
    )
  }

  private func backupSubtitle(for backup: DesignBackup) -> String {
    let accountsText = backup.accountCount == 1 ? "1 account" : "\(backup.accountCount) accounts"
    if !backup.size.isEmpty {
      return "\(accountsText) · \(backup.size) · \(backup.location)"
    }
    return "\(accountsText) · \(backup.location)"
  }

  private func chooseBackup() {
    if model.importBackupPackage() { presentImportedBackup() }
  }

  private func presentImportedBackup() {
    guard let id = model.pendingImportBackupID else { return }
    activeSheet = .review(BackupPresentation(id: id, importedPackage: true))
    model.pendingImportBackupID = nil
  }

  private var paneActions: some View {
    DesignPaneActions {
      DesignSheetButton(
        title: "Export Accounts…",
        enabled: !model.isBusy && model.accounts.contains { $0.kind == .saved },
        identifier: "backups.choose-accounts"
      ) { activeSheet = .create }
      DesignSheetButton(
        title: "Review Backup…",
        enabled: !model.isBusy,
        identifier: "backups.import"
      ) { chooseBackup() }
    }
  }

  @ViewBuilder
  private var backupInspectionSection: some View {
    switch model.backupInspectionState {
    case .idle, .ready:
      EmptyView()
    case .reading, .importing:
      Section {
        HStack(spacing: 8) {
          ProgressView()
            .controlSize(.small)
          Text(model.backupInspectionMessage ?? "Reading Backup…")
            .foregroundStyle(.secondary)
        }
        .accessibilityIdentifier("backups.inspection.\(model.backupInspectionState.rawValue)")
      }
    case .damaged:
      backupIssue(
        title: "Backup Is Damaged or Incomplete",
        message: model.backupInspectionMessage ?? "Nothing was imported.",
        actionTitle: "Choose Another File…",
        action: chooseBackup
      )
    case .newerVersion:
      backupIssue(
        title: "Created by a Newer AnyPick Version",
        message: model.backupInspectionMessage ?? "Update AnyPick, then review the file again.",
        actionTitle: "Choose Another File…",
        action: chooseBackup
      )
    case .permissionDenied:
      backupIssue(
        title: "Can’t Read This File",
        message: model.backupInspectionMessage ?? "AnyPick does not have permission to open it.",
        actionTitle: "Choose Another File…",
        action: chooseBackup
      )
    case .missing:
      backupIssue(
        title: "Can’t Find This File",
        message: model.backupInspectionMessage ?? "It may have been moved or deleted.",
        actionTitle: "Choose Another File…",
        action: chooseBackup
      )
    case .expired:
      backupIssue(
        title: "Review Expired",
        message: model.backupInspectionMessage ?? "Review the backup again before importing.",
        actionTitle: "Review Again…",
        action: chooseBackup
      )
    case .success:
      backupResult(
        title: model.backupInspectionMessage ?? "Accounts Imported",
        message: "Only the accounts selected in the protected review copy were changed.",
        symbol: "checkmark.circle.fill"
      )
    case .atomicFailure:
      backupIssue(
        title: "Couldn’t Import Accounts",
        message: model.backupInspectionMessage ?? "No saved accounts were changed.",
        actionTitle: "Review Again…",
        action: chooseBackup
      )
    }
  }

  private func backupIssue(
    title: String,
    message: String,
    actionTitle: String,
    action: @escaping () -> Void
  ) -> some View {
    Section {
      LabeledContent {
        Button(actionTitle, action: action)
          .help(message)
      } label: {
        Label {
          VStack(alignment: .leading, spacing: 2) {
            Text(title)
              .font(.body.weight(.medium))
            Text(message)
              .font(.subheadline)
              .foregroundStyle(.secondary)
          }
        } icon: {
          DesignWarningSymbol()
        }
      }
      .accessibilityIdentifier("backups.inspection.\(model.backupInspectionState.rawValue)")
    }
  }

  private func backupResult(title: String, message: String, symbol: String) -> some View {
    Section {
      Label {
        VStack(alignment: .leading, spacing: 2) {
          Text(title)
            .font(.body.weight(.medium))
          Text(message)
            .font(.subheadline)
            .foregroundStyle(.secondary)
        }
      } icon: {
        Image(systemName: symbol)
          .foregroundStyle(.green)
      }
    }
  }
}
