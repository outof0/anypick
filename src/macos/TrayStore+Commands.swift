import AppKit
import Foundation
import SwiftUI
/// Service and UI commands.
@MainActor
extension TrayStore {
  func openAnyPick() { emit("open") }

  func refreshAll() { emit("refresh") }

  func restartProxies() {
    mutate(
      operation: "proxy-restart-all",
      name: "all",
      activityLabel: "restarting enabled proxies"
    )
  }

  func stopProxies() {
    mutate(operation: "proxy-stop-all", name: "all", activityLabel: "stopping all proxies")
  }

  func navigate(_ screen: String) { emit("navigate\t\(screen)") }

  func copyAddress(_ address: String) {
    NSPasteboard.general.clearContents()
    NSPasteboard.general.setString(address, forType: .string)
    showMessage("Copied to clipboard.", isError: false)
  }

  func copyLogs(for sourceId: String) {
    guard let text = logsBySource[sourceId], !text.isEmpty else { return }
    NSPasteboard.general.clearContents()
    NSPasteboard.general.setString(text, forType: .string)
    showMessage("Copied to clipboard.", isError: false)
  }

  func dismissMessage() {
    messageDismissTask?.cancel()
    messageDismissTask = nil
    withAnimation(TrayMotion.message) { message = nil }
  }

  func quitAnyPick() {
    if let quitHandler { quitHandler() } else { NSApp.terminate(nil) }
  }
}
