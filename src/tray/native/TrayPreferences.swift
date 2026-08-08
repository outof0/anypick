import AppKit
import Foundation
import SwiftUI

// Module: TrayPreferences.swift — local UI prefs (UserDefaults, not supervisor state)

/// Menu-bar / main-window chrome preferences only.
/// Activation, accounts, and proxies stay with the Node supervisor (ADR 0006/0009).
enum TrayPreferences {
  private static let defaults = UserDefaults.standard
  private static let prefix = "dev.anypick.tray."

  /// Keys for `@AppStorage` (SwiftUI invalidation) and `UserDefaults`.
  enum Key {
    static let onboardingDismissed = prefix + "onboardingDismissed"
    static let quickSection = prefix + "quickSection"
    static let mainTab = prefix + "mainTab"
  }

  /// User chose “Not Now” / “Got It” on the setup checklist.
  static var onboardingDismissed: Bool {
    get { defaults.bool(forKey: Key.onboardingDismissed) }
    set { defaults.set(newValue, forKey: Key.onboardingDismissed) }
  }

  /// Last Apps / Proxies / Logs segment in the menu-bar panel.
  static var quickSectionRaw: String? {
    get { defaults.string(forKey: Key.quickSection) }
    set { defaults.set(newValue, forKey: Key.quickSection) }
  }

  /// Last primary sidebar destination in the main window.
  static var mainTabRaw: String? {
    get { defaults.string(forKey: Key.mainTab) }
    set { defaults.set(newValue, forKey: Key.mainTab) }
  }

  static func resetOnboarding() {
    onboardingDismissed = false
  }

  /// Call when the machine is back to zero config so tips reappear.
  static func resetOnboardingIfEmpty(isFirstRun: Bool) {
    if isFirstRun { onboardingDismissed = false }
  }
}
