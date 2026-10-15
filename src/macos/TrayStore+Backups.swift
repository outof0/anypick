import AppKit
import Foundation
import SwiftUI
/// Backup inspection.
@MainActor
extension TrayStore {
  @discardableResult
  func inspectBackup(path: String) -> String? {
    let requestId = UUID().uuidString
    let request = BackupInspectRequest(requestId: requestId, path: path)
    guard let data = encodeCommand(request) else { return nil }
    backupPreviewTimeoutTask?.cancel()
    if inspectedBackupPath != path {
      backupPreview = nil
    }
    inspectedBackupPath = path
    backupPreviewRequestId = requestId
    emit("backup-inspect\t\(data.base64EncodedString())")
    backupPreviewTimeoutTask = Task { @MainActor [weak self] in
      // Inspecting a large archive (read, parse, validate) is legitimately
      // slower than a log tail, and the engine answers within its own budget,
      // so this is only the last-resort bound.
      try? await Task.sleep(nanoseconds: 30_000_000_000)
      guard !Task.isCancelled,
            let self,
            self.backupPreviewRequestId == requestId else { return }
      self.backupPreviewRequestId = nil
      self.backupPreview = BackupPreviewResult(
        version: 1,
        requestId: requestId,
        status: "error",
        inspectionId: nil,
        createdAt: nil,
        entries: nil,
        error: "inspection-failed",
        code: "BACKUP_INSPECT_FAILED",
        reason: "timeout",
        message: DesktopMessageCatalog.text(
          "desktop.backups.timeout_detail",
          preference: settings.language ?? "auto",
          resolved: settings.resolvedLanguage ?? DesktopMessageCatalog.systemLanguage
        )
      )
    }
    return requestId
  }

  func clearBackupPreview() {
    backupPreviewTimeoutTask?.cancel()
    backupPreviewTimeoutTask = nil
    backupPreviewRequestId = nil
    inspectedBackupPath = nil
    backupPreview = nil
  }
}
