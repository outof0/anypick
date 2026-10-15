import AppKit
import Combine
import Foundation
import UniformTypeIdentifiers
/// Backup inspection sync.
@MainActor
extension ProductionDesignModel {
  func synchronizeBackupInspectionState() {
    if store.backupPreviewRequestId != nil {
      backupInspectionState = .reading
      backupInspectionMessage = localized("desktop.backups.reading_protected_copy")
      return
    }
    if backupInspectionState == .importing || backupInspectionState == .success
      || backupInspectionState == .expired || backupInspectionState == .atomicFailure
    {
      return
    }
    if let preview = store.backupPreview, preview.status == "error" {
      switch preview.reason {
      case "newer-version": backupInspectionState = .newerVersion
      case "permission-denied": backupInspectionState = .permissionDenied
      case "missing": backupInspectionState = .missing
      case "timeout": backupInspectionState = .damaged
      default: backupInspectionState = .damaged
      }
      backupInspectionMessage = preview.message ?? localized("desktop.backups.nothing_imported_choose_another")
    } else if store.backupPreview?.status == "ready" {
      backupInspectionState = .ready
      backupInspectionMessage = nil
    } else {
      backupInspectionState = .idle
      backupInspectionMessage = nil
    }
  }

  func synchronizeBackupPreview() {
    guard let preview = store.backupPreview,
      preview.status == "ready",
      let inspectionId = preview.inspectionId,
      let entries = preview.entries
    else { return }
    let previewAccounts = entries.map {
      DesignAccount(
        id: $0.id,
        name: $0.label,
        detail: $0.disposition == "replace" ? "Will replace saved account" : "Ready to import",
        provider: nativeProviderName($0.providerId),
        symbol: providerSymbol($0.providerId),
        kind: .saved,
        status: $0.disposition == "blocked" || $0.disposition == "unavailable"
          ? .unavailable : .ready,
        lastUsed: $0.disposition.capitalized,
        providerID: $0.providerId,
        importReplacesSaved: $0.disposition == "replace"
      )
    }
    backups = [
      DesignBackup(
        id: inspectionId,
        createdAt: preview.createdAt ?? "Imported backup",
        accountCount: previewAccounts.count,
        size: "Inspected package",
        location: importedBackupFileName ?? "Selected file",
        accounts: previewAccounts
      )
    ]
    if presentedInspectionID != inspectionId {
      presentedInspectionID = inspectionId
      pendingImportBackupID = inspectionId
    }
  }
}
