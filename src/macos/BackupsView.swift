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
            Text(model.localized("desktop.backups.warning_title"))
              .font(.body.weight(.medium))
            Text(model.localized("desktop.backups.warning_detail"))
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
            text: model.localized("desktop.backups.empty_reviewed")
          )
        } else {
          ForEach(model.backups) { backup in
            LabeledContent {
              HStack(spacing: 8) {
                Button(model.localized("desktop.backups.review")) {
                  // Backups born in this list are restored, not imported:
                  // only a package picked via Choose/pendingImport carries
                  // importedPackage: true (presentImportedBackup).
                  activeSheet = .review(BackupPresentation(id: backup.id, importedPackage: false))
                }
                .controlSize(.small)
                .buttonStyle(.bordered)
                .help(model.localized("desktop.backups.review_help"))

                DesignMoreActionsMenu(
                  label: model.localized("desktop.backups.more_options"),
                  identifier: "backups.more.\(backup.id)"
                ) {
                  Button(model.localized("desktop.backups.review_backup")) {
                    activeSheet = .review(BackupPresentation(id: backup.id, importedPackage: false))
                  }
                  .help(model.localized("desktop.backups.review_backup_help"))
                  Button(model.localized("desktop.backups.copy_path")) {
                    copyLocation(backup.location)
                  }
                  .help(model.localized("desktop.backups.copy_path_help"))
                  Divider()
                  Button(model.localized("desktop.backups.forget_review"), role: .destructive) {
                    requestForget(backup)
                  }
                  .help(model.localized("desktop.backups.forget_review_help"))
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
                  Text(backupCreatedAt(backup.createdAt))
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
              Button(model.localized("desktop.backups.review_backup")) {
                activeSheet = .review(BackupPresentation(id: backup.id, importedPackage: false))
              }
              .help(model.localized("desktop.backups.review_backup_help"))
              Button(model.localized("desktop.backups.copy_path")) {
                copyLocation(backup.location)
              }
              .help(model.localized("desktop.backups.copy_path_help"))
              Divider()
              Button(model.localized("desktop.backups.forget_review"), role: .destructive) {
                requestForget(backup)
              }
              .help(model.localized("desktop.backups.forget_review_help"))
            }
            .accessibilityIdentifier("backups.inventory.\(backup.id)")
          }
        }
      } header: {
        Text(model.localized("desktop.backups.reviewed_title"))
      } footer: {
        // Saved accounts only, and forgetting also discards the staged server
        // copy; TTL remains the backstop if the forget frame is lost.
        Text(
          model.localized("desktop.backups.reviewed_footer")
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
    .designConfirmation($confirmation, model: model)
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
      model.announceOnly(model.localized("desktop.backups.copied_path"))
    } else {
      model.announceOnly(model.localized("desktop.backups.copy_path_failed"))
    }
  }

  private func requestForget(_ backup: DesignBackup) {
    confirmation = DesignConfirmation(
      id: "forget-backup-review",
      title: model.localized("desktop.backups.forget_title"),
      message: model.localized("desktop.backups.forget_message"),
      action: .confirm(model.localized("desktop.backups.forget_confirm")) {
        model.deleteBackup(id: backup.id)
      }
    )
  }

  private func backupSubtitle(for backup: DesignBackup) -> String {
    let countKey = backup.accountCount == 1
      ? "desktop.backups.account_one" : "desktop.backups.account_many"
    let accountsText = String(format: model.localized(countKey), backup.accountCount)
    if !backup.size.isEmpty {
      return "\(accountsText) · \(backup.size) · \(backup.location)"
    }
    return "\(accountsText) · \(backup.location)"
  }

  private func backupCreatedAt(_ value: String) -> String {
    let localeID = model.selectedLanguage == "auto" ? model.resolvedLanguage : model.selectedLanguage
    let locale = Locale(identifier: localeID)
    let display = DateFormatter()
    display.locale = locale
    display.dateStyle = .medium
    display.timeStyle = .short

    if value.hasPrefix("Today at ") {
      return String(
        format: model.localized("desktop.backups.today_at"),
        arguments: [String(value.dropFirst("Today at ".count))]
      )
    }
    if value.hasPrefix("Yesterday at ") {
      return String(
        format: model.localized("desktop.backups.yesterday_at"),
        arguments: [String(value.dropFirst("Yesterday at ".count))]
      )
    }

    let iso = ISO8601DateFormatter()
    iso.formatOptions = [.withInternetDateTime, .withFractionalSeconds]
    if let date = iso.date(from: value) ?? ISO8601DateFormatter().date(from: value) {
      return display.string(from: date)
    }

    let source = DateFormatter()
    source.locale = Locale(identifier: ["en", "US", "POSIX"].joined(separator: "_"))
    source.isLenient = true
    source.defaultDate = Date()
    for format in ["MMMM d 'at' HH:mm", "d MMM yyyy 'at' HH:mm"] {
      source.dateFormat = format
      if let date = source.date(from: value) {
        return display.string(from: date)
      }
    }
    return value
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
        title: model.localized("desktop.backups.export_accounts"),
        enabled: !model.isBusy && model.accounts.contains { $0.kind == .saved },
        identifier: "backups.choose-accounts"
      ) { activeSheet = .create }
      DesignSheetButton(
        title: model.localized("desktop.backups.review_backup"),
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
          Text(model.backupInspectionMessage ?? model.localized("desktop.backups.reading"))
            .foregroundStyle(.secondary)
        }
        .accessibilityIdentifier("backups.inspection.\(model.backupInspectionState.rawValue)")
      }
    case .damaged:
      backupIssue(
        title: model.localized("desktop.backups.damaged_title"),
        message: model.backupInspectionMessage ?? model.localized("desktop.backups.nothing_imported"),
        actionTitle: model.localized("desktop.backups.choose_another"),
        action: chooseBackup
      )
    case .newerVersion:
      backupIssue(
        title: model.localized("desktop.backups.newer_version_title"),
        message: model.backupInspectionMessage ?? model.localized("desktop.backups.newer_version_detail"),
        actionTitle: model.localized("desktop.backups.choose_another"),
        action: chooseBackup
      )
    case .permissionDenied:
      backupIssue(
        title: model.localized("desktop.backups.permission_title"),
        message: model.backupInspectionMessage ?? model.localized("desktop.backups.permission_detail"),
        actionTitle: model.localized("desktop.backups.choose_another"),
        action: chooseBackup
      )
    case .missing:
      backupIssue(
        title: model.localized("desktop.backups.missing_title"),
        message: model.backupInspectionMessage ?? model.localized("desktop.backups.missing_detail"),
        actionTitle: model.localized("desktop.backups.choose_another"),
        action: chooseBackup
      )
    case .expired:
      backupIssue(
        title: model.localized("desktop.backups.expired_title"),
        message: model.backupInspectionMessage ?? model.localized("desktop.backups.expired_detail"),
        actionTitle: model.localized("desktop.backups.review_again"),
        action: chooseBackup
      )
    case .success:
      backupResult(
        title: model.backupInspectionMessage ?? model.localized("desktop.backups.imported_title"),
        message: model.localized("desktop.backups.imported_detail"),
        symbol: "checkmark.circle.fill"
      )
    case .atomicFailure:
      backupIssue(
        title: model.localized("desktop.backups.import_failed_title"),
        message: model.backupInspectionMessage ?? model.localized("desktop.backups.no_accounts_changed"),
        actionTitle: model.localized("desktop.backups.review_again"),
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
