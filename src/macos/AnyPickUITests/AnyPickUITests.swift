import AppKit
import CoreGraphics
import XCTest

/// Drives the three ship-acceptance flows through the real UI on fixture data.
/// Fixture mode has no Go service and no disk access, so these runs need no
/// login and leave `~/.anypick` untouched.
final class AnyPickUITests: XCTestCase {
  private let timeout: TimeInterval = 10

  override func setUp() {
    continueAfterFailure = false
    hideOtherApps()
  }

  /// Windows of other apps above AnyPick swallow synthesized clicks, and
  /// XCTest's interruption check can throw on their elements. Hide every
  /// other app that can own a window for the run; they come back from the
  /// Dock or Cmd-Tab.
  private func hideOtherApps() {
    let me = ProcessInfo.processInfo.processIdentifier
    let others = NSWorkspace.shared.runningApplications.filter {
      $0.activationPolicy != .prohibited && !$0.isHidden
        && $0.bundleIdentifier != "dev.anypick.app"
        && $0.bundleIdentifier != "com.apple.finder"
        && $0.processIdentifier != me
    }
    others.forEach { $0.hide() }
    let deadline = Date().addingTimeInterval(3)
    while Date() < deadline, others.contains(where: { !$0.isHidden }) {
      RunLoop.current.run(until: Date().addingTimeInterval(0.1))
    }
  }

  private func launch(fixture: String, flow: String? = nil, tray: String? = nil) -> XCUIApplication {
    let app = XCUIApplication()
    app.launchEnvironment["ANYPICK_MACOS_FIXTURE"] = fixture
    if let flow { app.launchEnvironment["ANYPICK_MACOS_FLOW"] = flow }
    if let tray { app.launchEnvironment["ANYPICK_MACOS_TRAY"] = tray }
    app.launchArguments += ["-ApplePersistenceIgnoreState", "YES"]
    app.launch()
    hideOtherApps()
    // Other full-screen apps (and Stage Manager) can keep AnyPick behind them,
    // which swallows clicks and defers the Welcome sheet; bring it forward.
    app.activate()
    XCTAssertTrue(app.wait(for: .runningForeground, timeout: timeout), "AnyPick never came to the foreground")
    // TCC / Automation alerts sit in UserNotificationCenter outside the app
    // process. XCTest still synthesizes clicks on sheet.primary through them,
    // but AppKit never fires — looking like Welcome "did not dismiss".
    assertNoSystemPermissionDialog()
    return app
  }

  /// Fail fast when a system permission sheet covers the display. Those
  /// windows are invisible to XCTest's interruption monitor.
  private func assertNoSystemPermissionDialog() {
    let options = CGWindowListOption(arrayLiteral: .optionOnScreenOnly, .excludeDesktopElements)
    let windows = CGWindowListCopyWindowInfo(options, kCGNullWindowID) as? [[String: Any]] ?? []
    let blocking = windows.contains {
      ($0[kCGWindowOwnerName as String] as? String) == "UserNotificationCenter"
    }
    XCTAssertFalse(
      blocking,
      "System permission dialog (UserNotificationCenter) is covering the display; dismiss it and re-run. XCTest synthesizes sheet clicks through it without firing AppKit actions.")
  }

  private func element(_ app: XCUIApplication, _ id: String) -> XCUIElement {
    app.descendants(matching: .any)[id].firstMatch
  }

  private func button(_ app: XCUIApplication, _ label: String, in container: XCUIElement? = nil) -> XCUIElement {
    (container ?? app).buttons[label].firstMatch
  }

  private func waitFor(_ element: XCUIElement, _ what: String) {
    XCTAssertTrue(element.waitForExistence(timeout: timeout), "\(what) never appeared")
  }

  /// Kept only when the test fails. XCUIScreen captures the whole display, so on a
  /// Mac someone is using a passing run must not leave other windows in the xcresult.
  private func attachScreenshot(_ name: String) {
    let shot = XCTAttachment(screenshot: XCUIScreen.main.screenshot())
    shot.name = name
    shot.lifetime = .deleteOnSuccess
    add(shot)
  }

  private func welcomeSheet(_ app: XCUIApplication) -> XCUIElement {
    // The sheet title is a header whose text lives in its AX label, which the
    // subscript lookup does not match on macOS; match the label explicitly.
    let sheet = app.sheets.containing(
      NSPredicate(format: "label == %@", "Welcome to AnyPick")
    ).firstMatch
    waitFor(sheet, "Welcome sheet")
    return sheet
  }

  /// Leaves Welcome by its secondary action, for tests that start from the
  /// Get Started checklist rather than from adding a login.
  private func dismissWelcome(_ app: XCUIApplication) {
    let sheet = welcomeSheet(app)
    let notNow = sheet.buttons["sheet.cancel"].firstMatch
    waitFor(notNow, "Welcome Not Now button")
    XCTAssertEqual(notNow.title, "Not Now")
    notNow.click()
    XCTAssertTrue(sheet.waitForNonExistence(timeout: timeout), "Welcome sheet did not dismiss")
  }

  private func waitForAddLoginSheet(_ app: XCUIApplication, _ after: String) {
    waitFor(element(app, "account-flow.save"), "Add Login sheet after \(after)")
  }

  // Design step 1: First launch → Welcome → Add Login… lands on the Add sheet,
  // not on a pane the user still has to find the button in.
  func testWelcomeAddLoginOpensAddSheet() {
    let app = launch(fixture: "empty")
    let sheet = welcomeSheet(app)
    attachScreenshot("1-welcome")
    let primary = sheet.buttons["sheet.primary"].firstMatch
    waitFor(primary, "Welcome Add Login button")
    XCTAssertEqual(primary.title, "Add Login…")
    primary.click()
    XCTAssertTrue(sheet.waitForNonExistence(timeout: timeout), "Welcome sheet did not dismiss")
    waitForAddLoginSheet(app, "Welcome")
    attachScreenshot("1-welcome-add-login-sheet")
    app.terminate()
  }

  // Design step 1, checklist path: Not Now → Add a Login opens the same sheet;
  // cancelling it leaves the empty Accounts pane, whose Add Login… opens it
  // again. Point an App opens Apps.
  func testChecklistAddLoginAndEmptyAccountsShareOneSheet() {
    var app = launch(fixture: "empty")
    dismissWelcome(app)

    let checklist = element(app, "overview.get-started")
    waitFor(checklist, "Get Started checklist")
    let saveRow = element(app, "overview.onboarding.save-login")
    let routeRow = element(app, "overview.onboarding.choose-route")
    waitFor(saveRow, "Add a Login row")
    waitFor(routeRow, "Point an App row")
    XCTAssertEqual(saveRow.value as? String, "Not done")
    XCTAssertEqual(routeRow.value as? String, "Not done")
    attachScreenshot("1-checklist")

    // Each row collapses into its action button, which carries the row id.
    XCTAssertEqual(saveRow.label, "Add Login…")
    saveRow.click()
    waitForAddLoginSheet(app, "the checklist")
    attachScreenshot("1-checklist-add-login-sheet")
    let cancel = app.sheets.buttons["sheet.cancel"].firstMatch
    waitFor(cancel, "Add Login sheet Cancel")
    cancel.click()
    waitFor(app.staticTexts["No Accounts"].firstMatch, "Accounts pane (No Accounts)")
    let emptyAccountsAddLogin = element(app, "accounts.empty.add-login")
    waitFor(emptyAccountsAddLogin, "empty Accounts Add Login button")
    emptyAccountsAddLogin.click()
    waitForAddLoginSheet(app, "empty Accounts")
    app.terminate()

    // Fresh launch for the second CTA so each CTA starts from the checklist.
    app = launch(fixture: "empty")
    dismissWelcome(app)
    let routeRowAgain = element(app, "overview.onboarding.choose-route")
    waitFor(routeRowAgain, "Point an App row")
    XCTAssertEqual(routeRowAgain.label, "Choose…")
    routeRowAgain.click()
    waitFor(app.staticTexts["No Apps Configured"].firstMatch, "Apps pane (No Apps Configured)")
    waitFor(app.buttons["Add App…"].firstMatch, "Apps empty-state Add App… button")
    attachScreenshot("1-point-app-opened-apps")
    app.terminate()
  }

  // Design step 2, branch without a live login: tray first-run → Add Login….
  // Design step 3: the Add sheet saves an account → tray leaves first run.
  func testTrayFirstRunAddLoginThenAddAccountLeavesFirstRun() {
    let app = launch(fixture: "empty", flow: "tray-first-run")
    let tray = app.windows["Menu Bar"].firstMatch
    waitFor(tray, "Menu Bar window")
    waitFor(tray.staticTexts["Add a login to start"].firstMatch, "tray first-run headline")
    let save = tray.descendants(matching: .any)["tray.first-run.save"].firstMatch
    waitFor(save, "tray.first-run.save")
    XCTAssertTrue(tray.buttons["Add Login…"].firstMatch.exists, "first-run CTA is not Add Login…")
    attachScreenshot("2-tray-first-run-no-live-login")
    save.click()

    let source = element(app, "account-flow.source")
    waitForAddLoginSheet(app, "the tray")
    if source.exists {
      let newAccount = source.radioButtons["New Account"].firstMatch
      if newAccount.exists { newAccount.click() } else { source.buttons["New Account"].firstMatch.click() }
    }
    let name = element(app, "account-flow.name")
    if name.exists {
      name.click()
      name.typeText("Work")
    }
    attachScreenshot("3-add-account-sheet")
    let submit = element(app, "account-flow.save")
    XCTAssertTrue(submit.isEnabled, "Add Login sheet primary button is disabled")
    submit.click()

    XCTAssertTrue(
      app.staticTexts["No Accounts"].firstMatch.waitForNonExistence(timeout: timeout),
      "Accounts pane still empty after adding an account")
    attachScreenshot("3-account-added")

    XCTAssertTrue(
      tray.descendants(matching: .any)["tray.first-run.save"].firstMatch
        .waitForNonExistence(timeout: timeout),
      "tray still shows first run after an account exists")
    attachScreenshot("3-tray-after-account")
    app.terminate()
  }

  // Design step 2, branch with a detected live login: Save This Login.
  // Fixture login only; the real OAuth path stays a human check.
  func testTrayFirstRunSaveThisLoginLeavesFirstRun() {
    let app = launch(fixture: "ready", flow: "tray-first-run", tray: "firstRun")
    let tray = app.windows["Menu Bar"].firstMatch
    waitFor(tray, "Menu Bar window")
    waitFor(tray.staticTexts["Save a login to start"].firstMatch, "tray first-run headline (live login)")
    let save = tray.descendants(matching: .any)["tray.first-run.save"].firstMatch
    waitFor(save, "tray.first-run.save")
    XCTAssertTrue(tray.buttons["Save This Login"].firstMatch.exists, "first-run CTA is not Save This Login")
    attachScreenshot("2-tray-first-run-live-login")
    save.click()
    XCTAssertTrue(save.waitForNonExistence(timeout: timeout), "tray stayed in first run after Save This Login")
    attachScreenshot("2-tray-after-save")
    app.terminate()
  }

  // Settings is a grouped preferences pane with a shortcut to reopen the
  // Overview checklist. Diagnostics and other status facts stay on Overview.
  func testSettingsPaneContainsPreferencesAndReopensGettingStarted() {
    let app = launch(fixture: "ready")
    let welcome = app.sheets.containing(
      NSPredicate(format: "label == %@", "Welcome to AnyPick")
    ).firstMatch
    if welcome.waitForExistence(timeout: 2) {
      dismissWelcome(app)
    }

    // The application menu and sidebar both route to the same main-window pane.
    let sidebarSettings = element(app, "sidebar.settings")
    waitFor(sidebarSettings, "sidebar.settings")
    sidebarSettings.click()

    let settingsPane = element(app, "settings.pane")
    waitFor(settingsPane, "settings pane")
    XCTAssertFalse(element(app, "settings.tabs").exists, "Settings should not contain tabs")
    XCTAssertFalse(
      app.windows.matching(
        NSPredicate(format: "identifier == %@", "com_apple_SwiftUI_Settings_window")
      ).firstMatch.exists,
      "Settings should remain in the main window")

    waitFor(element(app, "settings.open-at-login"), "settings.open-at-login")
    waitFor(element(app, "settings.start-enabled-proxies"), "settings.start-enabled-proxies")
    waitFor(element(app, "settings.show-usage"), "settings.show-usage")
    waitFor(element(app, "settings.quota-guard"), "settings.quota-guard")
    waitFor(element(app, "settings.language"), "settings.language")
    waitFor(element(app, "settings.show-getting-started"), "settings.show-getting-started")
    XCTAssertFalse(app.buttons["Open Proxies…"].firstMatch.exists)
    XCTAssertFalse(app.buttons["Manage Backups…"].firstMatch.exists)
    XCTAssertFalse(app.buttons["Check Now"].firstMatch.exists)
    XCTAssertFalse(app.staticTexts["Credentials"].firstMatch.exists)
    XCTAssertFalse(app.staticTexts["Connections"].firstMatch.exists)
    XCTAssertFalse(app.staticTexts["Encryption"].firstMatch.exists)
    attachScreenshot("settings-pane")

    element(app, "settings.show-getting-started").click()
    waitFor(element(app, "overview.get-started"), "Getting Started checklist reopened")

    element(app, "sidebar.proxies").click()
    waitFor(element(app, "sidebar.proxies"), "Proxies sidebar destination")
    app.typeKey(",", modifierFlags: .command)
    waitFor(element(app, "settings.pane"), "Settings from the app menu")
    app.terminate()
  }

  func testOverviewRunsInstallationDoctor() {
    let app = launch(fixture: "ready")
    let welcome = app.sheets.containing(
      NSPredicate(format: "label == %@", "Welcome to AnyPick")
    ).firstMatch
    if welcome.waitForExistence(timeout: 2) {
      dismissWelcome(app)
    }

    let runDoctor = element(app, "overview.run-doctor")
    waitFor(runDoctor, "Overview Doctor action")
    runDoctor.click()
    waitFor(element(app, "overview.doctor-summary"), "Doctor report")
    app.terminate()
  }
}
