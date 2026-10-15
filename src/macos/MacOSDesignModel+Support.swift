import AppKit
import Foundation
import SwiftUI
import UniformTypeIdentifiers
/// Announcements, feedback, and identity helpers.
@MainActor
extension MacOSDesignModel {
  /// VoiceOver-only success cue — no modal. Use for copy / non-blocking status.
  func announceOnly(_ message: String) {
    announce(DesktopMessageCatalog.text(
      source: message, preference: selectedLanguage, resolved: resolvedLanguage))
  }

  func announce(_ message: String) {
    NSAccessibility.post(
      element: NSApplication.shared,
      notification: .announcementRequested,
      userInfo: [.announcement: message, .priority: NSAccessibilityPriorityLevel.medium.rawValue]
    )
  }

  func dismissFeedback() {
    feedbackDismissTask?.cancel()
    feedback = nil
    // The offer belongs to the refusal that raised it: leaving it set would put
    // a stale "Manage with AnyPick" button on the next, unrelated error.
    pendingTakeover = nil
  }

  /// Errors use the native alert. Success is announced after the visible state
  /// changes; it does not create a second success surface.
  func showFeedback(
    _ message: String,
    title: String? = nil,
    kind: DesignFeedback.Kind = .information
  ) {
    let message = DesktopMessageCatalog.text(
      source: message, preference: selectedLanguage, resolved: resolvedLanguage)
    let title = title.map {
      DesktopMessageCatalog.text(source: $0, preference: selectedLanguage, resolved: resolvedLanguage)
    }
    feedbackDismissTask?.cancel()
    if kind == .error {
      feedback = DesignFeedback(title: title, message: message, kind: kind)
      return
    }
    announce(message)
    if kind == .success {
      if feedback?.kind != .error, feedback != nil { feedback = nil }
      return
    }
    feedback = DesignFeedback(title: title, message: message, kind: kind)
    if kind != .error {
      feedbackDismissTask = Task { @MainActor [weak self] in
        try? await Task.sleep(nanoseconds: 3_500_000_000)
        guard !Task.isCancelled else { return }
        if self?.feedback?.kind != .error {
          self?.feedback = nil
        }
      }
    }
  }

  func providerID(forRoute route: DesignRoute) -> String {
    if let providerID = route.providerID { return providerID }
    if route.kind == .gateway { return "openrouter" }
    if let account = accounts.first(where: { $0.id == route.id || $0.name == route.name }) {
      return account.provider
    }
    return route.id
  }
}
