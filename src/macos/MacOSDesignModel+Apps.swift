import AppKit
import Foundation
import SwiftUI
import UniformTypeIdentifiers
/// App route helpers for the fixture model.
@MainActor
extension MacOSDesignModel {
  func isSwitching(_ appID: String) -> Bool {
    if case .inFlight(let id, _, _, _) = switchPhase { return id == appID }
    return false
  }

  func applyRoute(appID: String, routeID: String) {
    guard let index = apps.firstIndex(where: { $0.id == appID }) else { return }
    let previousRoute = apps[index].selectedRouteID
    guard previousRoute != routeID else { return }
    commitRoute(appID: appID, routeID: routeID)
  }

  func setQuickPanelShown(appID: String, shows: Bool) {
    guard let index = apps.firstIndex(where: { $0.id == appID }) else { return }
    guard apps[index].showInQuickPanel != shows else { return }
    apps[index].showInQuickPanel = shows
    AppPreferences.setQuickPanelShown(shows, for: appID)
    recordActivity(
      title: "\(apps[index].name) \(shows ? "added to" : "removed from") Quick Panel",
      detail: shows
        ? "It now appears in the Quick Panel." : "It no longer appears in the Quick Panel.",
      symbol: "menubar.rectangle",
      status: shows ? .ready : .stopped
    )
    showFeedback(
      "\(apps[index].name) \(shows ? "now shows in" : "no longer shows in") the Quick Panel."
    )
  }

  func commitRoute(appID: String, routeID: String) {
    guard let index = apps.firstIndex(where: { $0.id == appID }) else { return }
    apps[index].selectedRouteID = routeID
    apps[index].status = .ready
    recordActivity(
      title: "\(apps[index].name) now uses \(routeName(routeID, for: apps[index]))",
      detail: "The change applied without restarting the app.",
      symbol: "arrow.triangle.2.circlepath",
      status: .ready
    )
    showFeedback("\(apps[index].name) now uses \(routeName(routeID, for: apps[index])).")
  }

  func routeName(_ routeID: String, for app: DesignApp) -> String {
    app.routeOptions.first(where: { $0.id == routeID })?.name ?? friendlyRouteKindLabel(.native, using: self)
  }
}
