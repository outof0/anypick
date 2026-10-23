import AppKit
import SwiftUI
import XCTest


/// Every destination must build its body and lay out without trapping.
/// Added after a "crash khi thao tác" report: SwiftUI body traps only
/// surface when the pane actually renders, so helper unit tests never
/// catch them. NSHostingView layout runs headless (no pixels drawn).
final class PaneRenderTests: XCTestCase {
  @MainActor
  private func render(_ view: some View) {
    let host = NSHostingView(rootView: AnyView(view))
    host.frame = NSRect(x: 0, y: 0, width: 920, height: 640)
    host.layoutSubtreeIfNeeded()
  }


  @MainActor
  func testAccountRowTrailingKeepsColumnsAlignedForEveryRow() {
    // The reported bug: a row whose action column is empty (a current account,
    // or a gateway with no Connect action) drew its marker and menu further in
    // than a row that had the button, so the controls did not line up. Measured
    // here, because "looks aligned" is not a property a later edit preserves.
    let model = MacOSDesignModel.fromEnvironment(["ANYPICK_MACOS_FIXTURE": "ready"])
    let account = model.accounts.first { $0.kind == .saved }
    XCTAssertNotNil(account, "fixture needs a saved account")

    func width(isCurrent: Bool, showsAction: Bool, hovered: Bool) -> CGFloat {
      let view = AccountRowTrailing(
        model: model,
        account: account!,
        displayName: "Work",
        isCurrent: isCurrent,
        showsAction: showsAction,
        isHovered: hovered,
        onEdit: {},
        onConnect: {},
        onRemove: {}
      )
      return NSHostingView(rootView: view).fittingSize.width
    }

    let currentRow = width(isCurrent: true, showsAction: false, hovered: false)
    let idleRow = width(isCurrent: false, showsAction: true, hovered: false)
    let hoveredRow = width(isCurrent: false, showsAction: true, hovered: true)
    let unavailableRow = width(isCurrent: false, showsAction: false, hovered: false)

    // All four states are the same width: the grid never collapses.
    XCTAssertEqual(currentRow, idleRow, accuracy: 0.5)
    XCTAssertEqual(idleRow, hoveredRow, accuracy: 0.5)
    XCTAssertEqual(idleRow, unavailableRow, accuracy: 0.5)
    // 72 (action) + 8 + 18 (marker) + 8 + the ellipsis menu + 8 + 14 (chevron).
    XCTAssertGreaterThan(
      currentRow,
      AccountRowTrailing.actionColumnWidth + AccountRowTrailing.statusColumnWidth
        + AccountRowTrailing.chevronColumnWidth
    )
  }

  @MainActor
  func testReservedColumnKeepsItsWidthWithoutContent() {
    // The bug this pins: `Group { if … }.frame(width:)` loses the width when
    // the cell is empty (SwiftUI drops a frame applied to EmptyView), so rows
    // with nothing in a column shifted left and the trailing controls stopped
    // lining up. Measured, not eyeballed: an empty cell and a filled cell must
    // report the same width.
    let empty = NSHostingView(rootView: ReservedColumn(width: 72) { EmptyView() })
    let filled = NSHostingView(rootView: ReservedColumn(width: 72) { Text("Switch") })
    let narrow = NSHostingView(rootView: ReservedColumn(width: 18) { EmptyView() })

    XCTAssertEqual(empty.fittingSize.width, 72, accuracy: 0.5)
    XCTAssertEqual(filled.fittingSize.width, 72, accuracy: 0.5)
    XCTAssertEqual(narrow.fittingSize.width, 18, accuracy: 0.5)
    XCTAssertEqual(empty.fittingSize.width, filled.fittingSize.width, accuracy: 0.5)
  }

  @MainActor
  func testEmptyCollectionPanesRenderWithoutTrapping() {
    // A fresh install has no accounts and no proxies, and that is the state a
    // screenshot review flagged: the empty state belongs to the pane, not to a
    // Form Section (where the grouped style gives it a card it was never meant
    // to have). The render gate only catches a trap, but it covers the path a
    // first-run user actually sees.
    let model = MacOSDesignModel.fromEnvironment(["ANYPICK_MACOS_FIXTURE": "ready"])
    model.proxies = []
    render(ProxiesView(model: model))
    model.accounts = []
    render(AccountsView(model: model))
  }

  @MainActor
  func testEditedPanesRenderWithoutTrapping() {
    let model = MacOSDesignModel.fromEnvironment(["ANYPICK_MACOS_FIXTURE": "ready"])
    XCTAssertFalse(model.accounts.isEmpty, "fixture needs accounts for row coverage")
    render(AccountsView(model: model))
    render(ProxiesView(model: model))
    render(ProxyHubView(model: model))
    render(PublishedModelsView(model: model))
    if let firstModel = model.publishedModels.first {
      render(PublishedModelInspectSheet(model: model, publishedModel: firstModel))
    }
    render(ActivityView(model: model))
    render(BackupsView(model: model))
    for account in model.accounts {
      render(AccountDetailView(model: model, accountID: account.id))
    }
    render(AccountDetailView(model: model, accountID: "no-such-account"))
    for app in model.apps {
      render(AppDetailView(model: model, appID: app.id))
    }
    for proxy in model.proxies {
      render(ProxyDetailView(model: model, proxyID: proxy.id))
    }
    render(ProxyDetailView(model: model, proxyID: "no-such-proxy"))
    let logsModel = MacOSDesignModel.fromEnvironment([
      "ANYPICK_MACOS_FIXTURE": "ready",
      "ANYPICK_MACOS_ACTIVITY_MODE": "logs",
    ])
    render(ActivityView(model: logsModel))
    // Both hub power states: the footer buttons attach to different
    // sections depending on conflicts, and the status row changes shape.
    model.proxyHubEnabled = false
    render(ProxyHubView(model: model))
    model.proxyHubEnabled = true
    render(ProxyHubView(model: model))
  }


  private func modelConfigApp(
    roles: [DesignModelRole],
    options: [String],
    editable: Bool = true
  ) -> DesignApp {
    DesignApp(
      id: "claude",
      name: "Claude Code",
      detail: "Uses Work",
      symbol: "s",
      status: .ready,
      accountCount: 1,
      selectedRouteID: "r1",
      routeOptions: [
        DesignRoute(
          id: "r1", name: "Work", detail: "work@example.com", symbol: "person",
          kind: .account, providerID: "codex")
      ],
      fastModel: "",
      reasoningModel: "",
      useCompatibleFallback: true,
      modelRoles: roles,
      modelOptions: options,
      modelEditingAvailable: editable
    )
  }

  func testConnectionSheetOffersModelStepOnlyWhenTheRoutePublishesModels() {
    let roles = [DesignModelRole(id: "default", label: "Default", modelID: "")]
    // No options, no roles, or a route that manages its own picker: all three
    // would render a dead control.
    XCTAssertFalse(appRouteOffersModelStep(modelConfigApp(roles: roles, options: [])))
    XCTAssertFalse(appRouteOffersModelStep(modelConfigApp(roles: [], options: ["m1"])))
    XCTAssertFalse(
      appRouteOffersModelStep(modelConfigApp(roles: roles, options: ["m1"], editable: false)))
    XCTAssertTrue(appRouteOffersModelStep(modelConfigApp(roles: roles, options: ["m1"])))
  }

  @MainActor
  func testConnectionSheetNudgesOnlyWhenNoDefaultIsPinned() {
    let empty = [DesignModelRole(id: "default", label: "Default", modelID: "")]
    let pinned = [DesignModelRole(id: "default", label: "Default", modelID: "m1")]
    let model = MacOSDesignModel.fromEnvironment(["ANYPICK_MACOS_FIXTURE": "ready"])
    model.apps = [
      modelConfigApp(roles: empty, options: ["m1"]),
    ]
    XCTAssertTrue(model.appRouteNeedsModelChoice(appID: "claude"))
    // An inherited provider default satisfies the nudge like a pin does.
    model.apps = [
      modelConfigApp(roles: empty, options: ["m1"]),
    ]
    model.providerModelDefaults["codex"] = ["default": "m1"]
    XCTAssertFalse(model.appRouteNeedsModelChoice(appID: "claude"))
    model.apps = [
      modelConfigApp(roles: pinned, options: ["m1"]),
    ]
    XCTAssertFalse(model.appRouteNeedsModelChoice(appID: "claude"))
  }

  @MainActor
  func testModelScopeSavesProviderDefaultAndResets() {
    let model = MacOSDesignModel.fromEnvironment(["ANYPICK_MACOS_FIXTURE": "ready"])
    guard let claude = model.apps.first(where: { $0.id == "claude" }),
      let route = claude.routeOptions.first(where: { $0.id == claude.selectedRouteID }),
      let key = model.modelRolesScopeKey(appID: "claude", route: route)
    else {
      return XCTFail("fixture needs a selected claude route with a scope key")
    }
    // Gateway and hub keys are namespaced, never bare provider ids.
    let openrouter = DesignRoute(
      id: "openrouter", name: "OpenRouter", detail: "", symbol: "",
      kind: .gateway, providerID: "openrouter")
    XCTAssertEqual(model.modelRolesScopeKey(appID: "x", route: openrouter), "gateway/OpenRouter")
    XCTAssertNil(model.modelRolesScopeKey(appID: "x", route: nil))
    // Start customized (fixture pins a default), reset to engine state.
    XCTAssertEqual(model.modelRolesProvenance(appID: "claude"), .custom)
    XCTAssertTrue(model.updateAppModelRoles(
      appID: "claude", routeID: route.id, modelRoles: [:], scope: .connection))
    XCTAssertEqual(model.modelRolesProvenance(appID: "claude"), .none)
    // Saving to the provider scope stores the default; pins stay empty so
    // the values read back inherited.
    XCTAssertTrue(model.updateAppModelRoles(
      appID: "claude", routeID: route.id,
      modelRoles: ["default": "m1"], scope: .provider))
    XCTAssertEqual(model.modelRolesProvenance(appID: "claude"), .inherited)
    XCTAssertEqual(model.effectiveModelRoles(appID: "claude")["default"], "m1")
    XCTAssertEqual(model.providerModelDefaults[key], ["default": "m1"])
    // Saving to the connection scope pins (customized from here on).
    XCTAssertTrue(model.updateAppModelRoles(
      appID: "claude", routeID: route.id,
      modelRoles: ["default": "m2"], scope: .connection))
    XCTAssertEqual(model.modelRolesProvenance(appID: "claude"), .custom)
    XCTAssertEqual(model.effectiveModelRoles(appID: "claude")["default"], "m2")
    // Reset clears the pins; the provider default shows through again.
    XCTAssertTrue(model.updateAppModelRoles(
      appID: "claude", routeID: route.id, modelRoles: [:], scope: .connection))
    XCTAssertEqual(model.modelRolesProvenance(appID: "claude"), .inherited)
    XCTAssertEqual(model.effectiveModelRoles(appID: "claude")["default"], "m1")
  }

  @MainActor
  func testRouteChangeDoesNotEnterFlightWhenAnotherChangeIsBusy() {
    let model = MacOSDesignModel.fromEnvironment(["ANYPICK_MACOS_FIXTURE": "ready"])
    model.isBusy = true

    XCTAssertFalse(model.setRoute(appID: "claude", routeID: "personal"))
    XCTAssertEqual(model.switchPhase, .idle)
    XCTAssertEqual(model.apps.first { $0.id == "claude" }?.selectedRouteID, "work")
  }

  @MainActor
  func testConnectionSheetRendersEveryStage() {
    let model = MacOSDesignModel.fromEnvironment(["ANYPICK_MACOS_FIXTURE": "ready"])
    for app in model.apps {
      render(AppRouteSheet(model: model, appID: app.id))
      render(AppModelsSheet(model: model, appID: app.id))
    }
  }

  @MainActor
  func testEverySheetBuildsItsBodyWithoutTrapping() {
    // DesignSheetHost wraps every sheet in a NavigationStack for the native
    // titlebar. A body trap there only surfaces when the sheet actually
    // renders, so build each one headlessly like the pane gate above.
    let model = MacOSDesignModel.fromEnvironment(["ANYPICK_MACOS_FIXTURE": "ready"])
    render(FirstRunWelcomeSheet(model: model))
    render(AddSavedAccountSheet(model: model))
    render(AddGatewaySheet(model: model))
    render(CreateBackupSheet(model: model))
    for app in model.apps {
      render(AppRouteSheet(model: model, appID: app.id))
      render(AppModelsSheet(model: model, appID: app.id))
    }
    guard let account = model.accounts.first(where: { $0.kind == .saved }) else {
      return XCTFail("fixture needs a saved account")
    }
    render(AccountInspectSheet(model: model, accountID: account.id))
    render(EditAccountSheet(model: model, accountID: account.id))
    guard let gateway = model.accounts.first(where: { $0.kind == .gateway }) else {
      return XCTFail("fixture needs a gateway account")
    }
    render(ConnectGatewaySheet(model: model, gatewayID: gateway.id))
    guard let backup = model.backups.first else {
      return XCTFail("fixture needs a backup")
    }
    render(RestoreBackupSheet(model: model, backupID: backup.id))
  }

  @MainActor
  func testUpdateCheckKeepsSectionHeightAcrossCheckingAndResult() {
    let model = MacOSDesignModel.fromEnvironment(["ANYPICK_MACOS_FIXTURE": "ready"])
    func height(_ fixture: String?) -> CGFloat {
      var environment: [String: String] = [:]
      if let fixture { environment["ANYPICK_MACOS_UPDATE_FIXTURE"] = fixture }
      let updates = UpdatesModel(environment: environment)
      let host = NSHostingView(rootView: Form {
        SettingsUpdatesPane(updates: updates, model: model)
      }.formStyle(.grouped).frame(width: 650).fixedSize(horizontal: false, vertical: true))
      return host.fittingSize.height
    }
    let idle = height(nil)
    XCTAssertGreaterThan(idle, 40)
    XCTAssertEqual(idle, height("checking"), accuracy: 0.5)
    XCTAssertEqual(idle, height("upToDate"), accuracy: 0.5)
  }

  @MainActor
  func testTrayQuotaCardRefusesHeightCompression() {
    let model = MacOSDesignModel.fromEnvironment(["ANYPICK_MACOS_FIXTURE": "ready"])
    var app = model.apps.first { $0.id == "gemini" }!
    let window = app.usageWindows[0]
    app.usageWindows = (0..<8).map { index in
      var value = window
      value.label = "Long provider quota window \(index)"
      return value
    }
    let measured = LayoutMeasurement()
    let host = NSHostingView(rootView: CompressedMeasurementLayout(measured: measured) {
      MenuBarAppCard(model: model, app: app, onSwitch: {})
    })
    _ = host.fittingSize
    XCTAssertGreaterThan(measured.size.height, 250,
      "Quota rows must reserve their height even when the panel proposes only 80pt")
    XCTAssertLessThanOrEqual(measured.size.width, 320.5)
  }

  @MainActor
  func testTrayPanelRendersEverySceneWithoutTrapping() {
    // The Quick Panel is plain native rows now; a body trap there only
    // surfaces when the panel actually renders, so build each scene
    // headlessly like the pane gate above.
    for flow in ["tray", "tray-attention", "tray-use-with", "tray-first-run"] {
      let model = MacOSDesignModel.fromEnvironment([
        "ANYPICK_MACOS_FIXTURE": "ready", "ANYPICK_MACOS_FLOW": flow,
      ])
      render(MenuBarMenu(model: model))
    }
    let empty = MacOSDesignModel.fromEnvironment(["ANYPICK_MACOS_FIXTURE": "empty"])
    render(MenuBarMenu(model: empty))
  }
}

private final class LayoutMeasurement {
  var size = CGSize.zero
}

private struct CompressedMeasurementLayout: Layout {
  let measured: LayoutMeasurement

  func sizeThatFits(proposal: ProposedViewSize, subviews: Subviews, cache: inout ()) -> CGSize {
    let size = subviews[0].sizeThatFits(ProposedViewSize(width: 320, height: 80))
    measured.size = size
    return size
  }

  func placeSubviews(in bounds: CGRect, proposal: ProposedViewSize, subviews: Subviews, cache: inout ()) {
    subviews[0].place(at: bounds.origin, proposal: ProposedViewSize(width: 320, height: 80))
  }
}
