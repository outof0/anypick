import AppKit
import Foundation
import SwiftUI

// Module: QuickNav.swift — tabs and navigation model

enum NativeTrayTab: String, CaseIterable, Identifiable, Hashable {
  case accounts = "Apps"
  case proxy = "Proxies"
  case monitor = "Logs"
  /// Sidebar + navigation title (content section still says “Saved accounts”).
  case manage = "Accounts"
  case modelAccounts = "Hub Sources"
  /// Nested under Apps — model defaults / role overrides for a client.
  case clientModels = "Model Settings"
  case routingIssues = "Routing Issues"
  case hubSetup = "Proxy Hub"
  case settings = "Settings"

  var id: String { rawValue }

  static let primary: [NativeTrayTab] = [.accounts, .proxy, .monitor, .manage, .settings]

  var isPrimary: Bool { Self.primary.contains(self) }
}

@MainActor
final class NativeNavigationModel: ObservableObject {
  @Published var tab: NativeTrayTab
  @Published var selectedClientModelId: String?

  init() {
    if let raw = TrayPreferences.mainTabRaw,
       let restored = NativeTrayTab(rawValue: raw),
       restored.isPrimary {
      tab = restored
    } else {
      tab = .accounts
    }
    selectedClientModelId = nil
  }

  var sidebarTab: NativeTrayTab {
    switch tab {
    case .clientModels: return .accounts
    case .manage: return .manage
    case .modelAccounts, .routingIssues, .hubSetup: return .proxy
    default: return tab
    }
  }

  func show(_ tab: NativeTrayTab, clientId: String? = nil) {
    selectedClientModelId = tab == .clientModels ? clientId : nil
    self.tab = tab
    // Persist only primary destinations so nested hub/models don't stick as “home”.
    if tab.isPrimary {
      TrayPreferences.mainTabRaw = tab.rawValue
    } else if sidebarTab.isPrimary {
      TrayPreferences.mainTabRaw = sidebarTab.rawValue
    }
  }
}
