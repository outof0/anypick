import AppKit
import SwiftUI
import XCTest
import UniformTypeIdentifiers

final class AnyPickTests: XCTestCase {
  @MainActor
  func testAccountImportPickerAcceptsBothExportExtensions() {
    let panel = makeAnyPickImportPanel()
    XCTAssertTrue(panel.allowedContentTypes.contains(.json))
    XCTAssertTrue(panel.allowedContentTypes.contains(anyPickBackupType))
    XCTAssertFalse(panel.canChooseDirectories)
    XCTAssertFalse(panel.allowsMultipleSelection)
  }

  func testBuiltAppContainsExecutableGoHelper() throws {
    let products = Bundle(for: Self.self).bundleURL.deletingLastPathComponent()
    let helper = products
      .appendingPathComponent("AnyPick.app/Contents/Helpers/anypick-core").path

    XCTAssertTrue(FileManager.default.fileExists(atPath: helper))
    XCTAssertTrue(FileManager.default.isExecutableFile(atPath: helper))
  }

  func testBuiltAppContainsNoNodePluginHost() throws {
    let app = Bundle(for: Self.self).bundleURL
      .deletingLastPathComponent()
      .appendingPathComponent("AnyPick.app")
    let resources = app.appendingPathComponent("Contents/Resources")
    let fileManager = FileManager.default

    XCTAssertFalse(
      fileManager.fileExists(atPath: resources.appendingPathComponent("plugin-host").path),
      "ADR 0020 forbids plugin-host resources in the app bundle"
    )
    XCTAssertFalse(
      fileManager.fileExists(
        atPath: resources.appendingPathComponent("plugin-host/plugin-host.mjs").path
      )
    )
    XCTAssertFalse(
      fileManager.fileExists(
        atPath: resources.appendingPathComponent("plugins/popular-providers/index.mjs").path
      )
    )
  }

  func testProjectUsesTheSharedSwiftSourceManifest() throws {
    let macOSDirectory = URL(fileURLWithPath: #filePath)
      .deletingLastPathComponent()
      .deletingLastPathComponent()
    let manifest = try String(
      contentsOf: macOSDirectory.appendingPathComponent("sources.txt"),
      encoding: .utf8
    )
    let entries = manifest.split(whereSeparator: \.isNewline).map(String.init)
    let project = try String(
      contentsOf: macOSDirectory
        .appendingPathComponent("AnyPick.xcodeproj/project.pbxproj"),
      encoding: .utf8
    )

    XCTAssertTrue(entries.contains("AppEntry.swift"))
    XCTAssertTrue(entries.contains("ProductionModel.swift"))
    XCTAssertEqual(entries.count, Set(entries).count)
    for entry in entries {
      // Extension files use the `Type+Feature.swift` convention; OpenStep
      // plist unquoted strings reject `+`, so those references are quoted.
      XCTAssertTrue(
        project.contains("path = \(entry);")
          || project.contains("path = \"\(entry)\";"),
        "AnyPick.xcodeproj does not reference shared source \(entry)"
      )
    }

    // The manifest and the project are two halves of one registration, so
    // checking only the manifest leaves a file the project compiles but the
    // manifest omits invisible — which is how `FrameChunkBuffer.swift` was
    // built without a row. `contentsOfDirectory` is not recursive, so this is
    // the top-level set; the test targets' files live in subdirectories and are
    // registered separately.
    let topLevelSources = try FileManager.default
      .contentsOfDirectory(atPath: macOSDirectory.path)
      .filter { $0.hasSuffix(".swift") }
    for source in topLevelSources {
      XCTAssertTrue(
        entries.contains(source),
        "src/macos/\(source) is compiled but absent from sources.txt"
      )
    }
    XCTAssertEqual(
      entries.count,
      topLevelSources.count,
      "sources.txt and the top-level Swift files disagree on how many sources exist"
    )
  }

  @MainActor
  func testConfirmationTitlesAreLocalizedInEveryCatalog() throws {
    let macOSDirectory = URL(fileURLWithPath: #filePath)
      .deletingLastPathComponent()
      .deletingLastPathComponent()
    let sources = try FileManager.default.contentsOfDirectory(atPath: macOSDirectory.path)
    var keys: Set<String> = []
    for name in sources where name.hasSuffix(".swift") {
      let text = try String(
        contentsOf: macOSDirectory.appendingPathComponent(name),
        encoding: .utf8
      )
      keys.formUnion(
        text.matches(of: /\.confirm\(model\.localized\("([^"]+)"/).map { String($0.1) }
      )
      XCTAssertFalse(
        text.contains(".confirm(\""),
        "\(name) has a confirmation title that bypasses the localization catalog"
      )
    }

    XCTAssertFalse(keys.isEmpty, "the scan matched no localized confirmation titles")
    let catalogDirectory = macOSDirectory
      .deletingLastPathComponent()
      .appendingPathComponent("go/internal/i18n", isDirectory: true)
    let locales = ["de", "en", "es", "fr", "ja", "ko", "pt-BR", "vi", "zh-CN"]
    for locale in locales {
      let url = catalogDirectory.appendingPathComponent("messages.\(locale).json")
      let data = try Data(contentsOf: url)
      let catalog = try XCTUnwrap(
        JSONSerialization.jsonObject(with: data) as? [String: [String: String]],
        "\(url.lastPathComponent) is not a desktop message catalog"
      )
      for key in keys {
        XCTAssertFalse(
          catalog[key]?["other"]?.isEmpty ?? true,
          "\(url.lastPathComponent) is missing localized confirmation key \(key)"
        )
      }
    }
  }

  func testTraditionalChineseRegionsFallBackToEnglish() {
    for locale in ["zh-Hant", "zh-TW", "zh-HK", "zh-MO"] {
      XCTAssertEqual(DesktopMessageCatalog.catalogID(locale), "en", "locale: \(locale)")
    }
    XCTAssertEqual(DesktopMessageCatalog.catalogID("zh-CN"), "zh-CN")
  }

  func testAppServiceClientNegotiatesBeforeDeliveringFrames() async throws {
    let client = AppServiceClient(appVersion: "(devel)", launchAtLogin: false)
    let hello = try frame(
      "hello",
      [
        "protocolVersion": 2,
        "messageVersion": 1,
        "engineVersion": "(devel)",
        "schemaVersion": 4,
        "capabilities": ["command-dto-v1", "doctor-v1", "snapshot-dto-v1"],
        "instanceId": "0123456789abcdef0123456789abcdef",
        "maxFrameBytes": 4 * 1024 * 1024,
      ]
    )
    let helloActions = try await client.consume(Data("\(hello)\n".utf8))
    XCTAssertEqual(helloActions.count, 2)
    guard case .state(.handshaking) = helloActions[0],
          case .send(let hostHello) = helloActions[1] else {
      return XCTFail("client did not acknowledge engine hello")
    }
    XCTAssertTrue(hostHello.hasPrefix("hello\t"))

    let ready = try frame(
      "ready",
      [
        "protocolVersion": 2,
        "capabilities": ["command-dto-v1", "doctor-v1", "snapshot-dto-v1"],
      ]
    )
    let readyActions = try await client.consume(Data("\(ready)\n".utf8))
    guard readyActions.count == 1, case .state(.ready) = readyActions[0] else {
      return XCTFail("client did not enter ready state")
    }

    let snapshot = try frame("snapshot", ["revision": 1])
    let frameActions = try await client.consume(Data("\(snapshot)\n".utf8))
    guard frameActions.count == 1, case .deliver(let delivered) = frameActions[0] else {
      return XCTFail("ready client did not deliver snapshot")
    }
    XCTAssertEqual(String(decoding: delivered, as: UTF8.self), "\(snapshot)\n")
  }

  func testAppServiceClientRejectsProtocolMismatch() async throws {
    let client = AppServiceClient(appVersion: "1.0.0", launchAtLogin: false)
    let hello = try frame(
      "hello",
      [
        "protocolVersion": 99,
        "messageVersion": 1,
        "engineVersion": "1.0.0",
        "schemaVersion": 4,
        "capabilities": ["command-dto-v1", "doctor-v1", "snapshot-dto-v1"],
        "instanceId": "0123456789abcdef0123456789abcdef",
        "maxFrameBytes": 4 * 1024 * 1024,
      ]
    )
    do {
      _ = try await client.consume(Data("\(hello)\n".utf8))
      XCTFail("protocol mismatch was accepted")
    } catch let error as AppServiceProtocolError {
      XCTAssertTrue(error.localizedDescription.contains("protocol 99"))
    }
  }

  func testAppServiceClientDoesNotEchoUnexpectedFramePayload() async throws {
    let client = AppServiceClient(appVersion: "(devel)", launchAtLogin: false)
    let secret = String(repeating: "A", count: 512)
    do {
      _ = try await client.consume(Data("\(secret)\topaque\n".utf8))
      XCTFail("untrusted frame was accepted")
    } catch let error as AppServiceProtocolError {
      XCTAssertEqual(
        error.localizedDescription,
        "The AnyPick service sent an unexpected protocol frame."
      )
      XCTAssertFalse(error.localizedDescription.contains(secret))
    }
  }

  func testTraySnapshotDecodesPluginDegradedConditions() throws {
    let payload: [String: Any] = [
      "revision": 1,
      "proxyCount": 0,
      "routes": [],
      "actions": [],
      "usage": [],
      "proxies": [],
      "accounts": [],
      "gateways": [],
      "accountProviders": [],
      "gatewayProviders": [],
      "settings": [
        "launchAtLogin": false,
        "startEnabledProxies": true,
        "showQuota": true,
        "quotaGuardEnabled": false,
      ],
      "activity": [],
      "degradedConditions": [
        [
          "id": "plugin-host",
          "kind": "plugin-host",
          "title": "Plugin host unavailable",
          "detail": "The private plugin host stopped.",
        ]
      ],
    ]
    let data = try JSONSerialization.data(withJSONObject: payload)
    let snapshot = try JSONDecoder().decode(TraySnapshot.self, from: data)

    XCTAssertEqual(snapshot.degradedConditions?.first?.id, "plugin-host")
    XCTAssertEqual(snapshot.degradedConditions?.first?.kind, "plugin-host")
  }

  func testTraySnapshotDecodesModelOptionsWithProviderIdentity() throws {
    let payload: [String: Any] = [
      "revision": 1,
      "proxyCount": 0,
      "routes": [],
      "actions": [],
      "usage": [],
      "proxies": [],
      "accounts": [],
      "gateways": [],
      "accountProviders": [],
      "gatewayProviders": [],
      "clientModelConfigs": [
        [
          "clientId": "claude",
          "client": "Claude Code",
          "roles": [],
          "modelRoles": [:],
          "options": [
            [
              "actionId": "act-1",
              "modelId": "gemini-2.5-pro",
              "providerId": "gemini",
              "sourceLabel": "gemini/antigravity",
            ]
          ],
          "editable": true,
        ]
      ],
      "settings": [
        "launchAtLogin": false,
        "startEnabledProxies": true,
        "showQuota": true,
        "quotaGuardEnabled": false,
      ],
      "activity": [],
    ]
    let data = try JSONSerialization.data(withJSONObject: payload)
    let snapshot = try JSONDecoder().decode(TraySnapshot.self, from: data)

    XCTAssertEqual(snapshot.clientModelConfigs?.first?.options.first?.providerId, "gemini")
  }

  func testTraySnapshotDecodesSubscriptionLoginSource() throws {
    let payload: [String: Any] = [
      "revision": 1,
      "proxyCount": 0,
      "routes": [],
      "actions": [],
      "usage": [],
      "proxies": [],
      "accounts": [],
      "gateways": [],
      "accountProviders": [[
        "id": "gemini",
        "providerId": "gemini",
        "clientId": "gemini",
        "label": "Google Gemini",
        "detail": "Google subscription or API key",
        "installed": true,
        "livePresent": true,
        "loginMethods": [[
          "id": "antigravity-subscription",
          "label": "Antigravity subscription",
          "detail": "Google browser sign-in for Antigravity-compatible access",
          "provenance": "official",
          "preferred": false,
          "available": true,
          "sourceId": "antigravity",
        ]],
        "credentialKinds": [],
      ]],
      "gatewayProviders": [],
      "settings": [
        "launchAtLogin": false,
        "startEnabledProxies": true,
        "showQuota": true,
        "quotaGuardEnabled": false,
      ],
      "activity": [],
    ]
    let data = try JSONSerialization.data(withJSONObject: payload)
    let snapshot = try JSONDecoder().decode(TraySnapshot.self, from: data)

    XCTAssertEqual(
      snapshot.accountProviders.first?.loginMethods?.first?.sourceID,
      "antigravity"
    )
    XCTAssertNil(snapshot.accountProviders.first?.acceptsAuthPaste)
  }

  func testAccountProviderDecodesAuthPasteFlag() throws {
    let present = """
      {"id":"codex","providerId":"codex","label":"OpenAI","detail":"","installed":true,"acceptsAuthPaste":true}
      """.data(using: .utf8)!
    let row = try JSONDecoder().decode(AccountProviderSnapshot.self, from: present)
    XCTAssertEqual(row.acceptsAuthPaste, true)

    let missing = """
      {"id":"gemini","providerId":"gemini","label":"Gemini","detail":"","installed":true}
      """.data(using: .utf8)!
    let gemini = try JSONDecoder().decode(AccountProviderSnapshot.self, from: missing)
    XCTAssertNil(gemini.acceptsAuthPaste)
  }

  func testAuthPasteForgetStaysInsideItsDirectory() throws {
    let path = try AuthPasteFiles.stage("{\"tokens\":{}}")
    XCTAssertTrue(FileManager.default.fileExists(atPath: path))
    let attrs = try FileManager.default.attributesOfItem(atPath: path)
    let mode = (attrs[.posixPermissions] as? NSNumber)?.intValue ?? 0
    XCTAssertEqual(mode & 0o777, 0o600)
    AuthPasteFiles.forget(path)
    XCTAssertFalse(FileManager.default.fileExists(atPath: path))
    AuthPasteFiles.forget(path)

    let outside = FileManager.default.temporaryDirectory
      .appendingPathComponent("anypick-auth-paste-evil", isDirectory: true)
    try FileManager.default.createDirectory(at: outside, withIntermediateDirectories: true)
    let victim = outside.appendingPathComponent("secret.json")
    try Data("keep".utf8).write(to: victim)
    AuthPasteFiles.forget(victim.path)
    XCTAssertEqual(try String(contentsOf: victim, encoding: .utf8), "keep")

    let link = URL(fileURLWithPath: path).deletingLastPathComponent()
      .appendingPathComponent("link.json")
    try? FileManager.default.removeItem(at: link)
    try FileManager.default.createSymbolicLink(at: link, withDestinationURL: victim)
    AuthPasteFiles.forget(link.path)
    XCTAssertEqual(try String(contentsOf: victim, encoding: .utf8), "keep")
    try FileManager.default.removeItem(at: link)
    try FileManager.default.removeItem(at: victim)

    XCTAssertThrowsError(try AuthPasteFiles.stage(String(repeating: "a", count: 256 * 1024 + 1))) { error in
      XCTAssertEqual(
        (error as? AuthPasteWriteError)?.localizationKey,
        "desktop.add_account.auth_too_large"
      )
    }
  }

  @MainActor
  func testFixturePasteReportsAnExistingName() {
    let model = MacOSDesignModel.fromEnvironment(["ANYPICK_MACOS_FIXTURE": "empty"])
    XCTAssertTrue(model.savePastedAuth(provider: "Claude", name: "work", path: "/tmp/a.json", overwrite: false))
    XCTAssertEqual(model.operationResult?.operation, "account-save-auth")
    XCTAssertEqual(model.operationResult?.succeeded, true)
    XCTAssertFalse(model.savePastedAuth(provider: "Claude", name: "work", path: "/tmp/a.json", overwrite: false))
    XCTAssertEqual(model.operationResult?.code, "ACCOUNT_EXISTS")
    XCTAssertEqual(model.accounts.filter { $0.name == "work" }.count, 1)
    XCTAssertTrue(model.savePastedAuth(provider: "Claude", name: "work", path: "/tmp/a.json", overwrite: true))
    XCTAssertEqual(model.accounts.filter { $0.name == "work" }.count, 1)
  }

  private func frame(_ prefix: String, _ object: Any) throws -> String {
    let data = try JSONSerialization.data(withJSONObject: object, options: [.sortedKeys])
    return "\(prefix)\t\(data.base64EncodedString())"
  }

  // MARK: - P1-01 route dedupe

  func testCompatibleRoutesDedupeKeepsCurrentOnce() {
    let selected = DesignRoute(
      id: "b", name: "Work", detail: "alex@studio.example", symbol: "person",
      kind: .account, providerID: "claude")
    let app = DesignApp(
      id: "claude", name: "Claude Code", detail: "Uses Work", symbol: "s",
      status: .ready, accountCount: 3, selectedRouteID: "b",
      routeOptions: [
        DesignRoute(
          id: "a", name: "Work", detail: "alex@studio.example", symbol: "person",
          kind: .account, providerID: "claude"),
        selected,
        DesignRoute(
          id: "c", name: "WORK", detail: "alex@studio.example", symbol: "person",
          kind: .account, providerID: "Claude"),
      ],
      fastModel: "", reasoningModel: "", useCompatibleFallback: true)
    let routes = compatibleAccountRoutes(in: app)
    XCTAssertEqual(routes.count, 1)
    XCTAssertEqual(routes.first?.id, "b")
  }

  func testCompatibleRoutesKeepDifferentProvidersSeparate() {
    let app = DesignApp(
      id: "codex", name: "Codex", detail: "", symbol: "s", status: .ready,
      accountCount: 2, selectedRouteID: "a",
      routeOptions: [
        DesignRoute(
          id: "a", name: "Work", detail: "alex@studio.example", symbol: "p",
          kind: .account, providerID: "claude"),
        DesignRoute(
          id: "b", name: "Work", detail: "alex@studio.example", symbol: "p",
          kind: .account, providerID: "codex"),
      ],
      fastModel: "", reasoningModel: "", useCompatibleFallback: true)
    XCTAssertEqual(compatibleAccountRoutes(in: app).count, 2)
  }

  // MARK: - P1-02 identity

  func testAccountIdentityLineHasNoDanglingSeparator() {
    XCTAssertEqual(accountIdentityLine(provider: "Claude", detail: ""), "Claude")
    XCTAssertEqual(accountIdentityLine(provider: "", detail: "alex@example.com"), "alex@example.com")
    XCTAssertEqual(accountIdentityLine(provider: "", detail: ""), "")
    XCTAssertEqual(
      accountIdentityLine(provider: "Claude", detail: "alex@example.com"),
      "Claude · alex@example.com")
  }

  func testAccountAccessibilityLabelDistinguishesDuplicates() {
    let first = DesignAccount(
      id: "1", name: "Work", detail: "alex@studio.example", provider: "Claude",
      symbol: "s", kind: .saved, status: .ready, lastUsed: "")
    let second = DesignAccount(
      id: "2", name: "Work", detail: "maya@studio.example", provider: "Codex",
      symbol: "s", kind: .saved, status: .ready, lastUsed: "")
    let all = [first, second]
    let firstLabel = accountAccessibilityLabel(for: first, in: all)
    let secondLabel = accountAccessibilityLabel(for: second, in: all)
    XCTAssertNotEqual(firstLabel, secondLabel)
    XCTAssertTrue(firstLabel.contains("Claude"))
    XCTAssertTrue(secondLabel.contains("Codex"))
    XCTAssertTrue(firstLabel.contains("1 of 2"))
    XCTAssertFalse(accountIdentityLine(provider: "Claude", detail: "").hasSuffix("·"))
  }

  // MARK: - P1-03 friendly copy

  func testFriendlyRouteDetailHidesInternalKinds() {
    XCTAssertEqual(friendlyRouteDetail(nil, routeKind: "direct-account"), "Direct account")
    XCTAssertEqual(friendlyRouteDetail(nil, routeKind: "managed-account"), "AnyPick proxy")
    XCTAssertEqual(friendlyRouteDetail("account", routeKind: "account"), "Saved account")
    XCTAssertEqual(friendlyRouteDetail("", routeKind: "gateway"), "API gateway")
    XCTAssertEqual(friendlyRouteDetail("Shared models", routeKind: "hub"), "Shared models")
    for raw in ["direct-account", "account", "provider/internal-id proxy"] {
      XCTAssertFalse(friendlyRouteDetail(raw, routeKind: raw).contains("/"))
      XCTAssertFalse(["direct-account", "account"].contains(friendlyRouteDetail(raw, routeKind: raw)))
    }
  }

  func testFriendlyProxyNameHidesCompositeID() {
    XCTAssertEqual(
      friendlyProxyName(label: "claude/abc123 proxy", providerId: "claude"), "Claude proxy")
    XCTAssertEqual(friendlyProxyName(label: "Claude Relay", providerId: "claude"), "Claude Relay")
  }

  func testCleanModelDisplayNameStripsRedundantPrefixes() {
    XCTAssertEqual(cleanModelDisplayName("gemini/gemini-2.5-flash"), "gemini-2.5-flash")
    XCTAssertEqual(cleanModelDisplayName("gemini/gemini-2.5-pro"), "gemini-2.5-pro")
    XCTAssertEqual(cleanModelDisplayName("opencode/claude-3-7-sonnet"), "claude-3-7-sonnet")
    XCTAssertEqual(cleanModelDisplayName("openai/gpt-4o"), "gpt-4o")
    XCTAssertEqual(cleanModelDisplayName("claude-3-5-sonnet"), "claude-3-5-sonnet")
    XCTAssertEqual(cleanModelDisplayName("Direct account"), "Direct account")
    XCTAssertEqual(cleanModelDisplayName("Same as Default"), "Same as Default")
    XCTAssertEqual(cleanModelDisplayName(""), "")
  }

  func testCleanSourceDisplayNameStripsRedundantPrefixes() {
    XCTAssertEqual(cleanSourceDisplayName("gemini/user"), "user")
    XCTAssertEqual(cleanSourceDisplayName("gemini/stacktify"), "stacktify")
    XCTAssertEqual(cleanSourceDisplayName("stacktify"), "stacktify")
    XCTAssertEqual(cleanSourceDisplayName("opencode/main"), "main")
    XCTAssertEqual(cleanSourceDisplayName(""), "")
  }

  // MARK: - P1-04 transport

  func testTransportNeverDirectWhenUnconfigured() {
    let app = DesignApp(
      id: "claude", name: "Claude Code", detail: "No login chosen", symbol: "s",
      status: .stopped, accountCount: 0, selectedRouteID: "",
      routeOptions: [], fastModel: "", reasoningModel: "", useCompatibleFallback: true)
    XCTAssertEqual(transportDisplayName(for: app), "Not Configured")
    XCTAssertFalse(isAppRouteConfigured(app))
  }

  func testTransportNamesManagedAccountAsAnyPickProxy() {
    let accountRoute = DesignRoute(
      id: "workbuddy-work", name: "WorkBuddy · work", detail: "", symbol: "s",
      kind: .account, providerID: "workbuddy")
    let app = overviewApp(id: "workbuddy", status: .ready, routes: [accountRoute])
    XCTAssertEqual(transportDisplayName(for: app), "AnyPick proxy")
  }

  // MARK: - P1-10 hub gating

  func testHubStartRequiresUsableModel() {
    XCTAssertEqual(usablePublishedModelCount([]), 0)
    let waiting = [
      DesignPublishedModel(
        modelID: "m", ownerAccountID: nil, ownerName: "Needs a choice",
        ownerProvider: "Claude", needsChoice: true)
    ]
    XCTAssertEqual(usablePublishedModelCount(waiting), 0)
    let usable = [
      DesignPublishedModel(
        modelID: "m", ownerAccountID: "1", ownerName: "Work",
        ownerProvider: "Claude", needsChoice: false)
    ]
    XCTAssertEqual(usablePublishedModelCount(usable), 1)
  }

  // MARK: - P1-05 activity labels stay per-event

  func testActivityAccessibilityLabelContainsDayTimeStatus() {
    let item = DesignActivity(
      id: "a1", day: "Today", time: "09:42", title: "Claude Code now uses Work",
      detail: "Applied.", symbol: "s", status: .ready, provider: "Claude")
    let label = activityAccessibilityLabel(for: item)
    XCTAssertTrue(label.contains("Today"))
    XCTAssertTrue(label.contains("09:42"))
    XCTAssertTrue(label.contains("Ready"))
    XCTAssertTrue(label.contains("Claude Code now uses Work"))
  }

  // MARK: - Dense fixtures

  func testLongNamesAndTwentyAccountsStayDistinguishable() {
    let longName = String(repeating: "Very Long Account Name ", count: 6)
    var accounts: [DesignAccount] = []
    for index in 0..<22 {
      accounts.append(
        DesignAccount(
          id: "a-\(index)", name: index < 2 ? longName : "Account \(index)",
          detail: "user\(index)@example.com", provider: index % 2 == 0 ? "Claude" : "Codex",
          symbol: "s", kind: .saved, status: .ready, lastUsed: ""))
    }
    let labels = Set(accounts.map { accountAccessibilityLabel(for: $0, in: accounts) })
    XCTAssertEqual(labels.count, accounts.count)
  }

  // MARK: - Accounts C2 gateway Test enablement

  func testGatewayTestStaysEnabledWhenNoApiKeyIsRequired() {
    // Grok reads ~/.grok/auth.json: empty key field must not disable Test.
    XCTAssertTrue(
      gatewayConnectionTestEnabled(requiresApiKey: false, apiKey: "", isBusy: false))
    XCTAssertFalse(
      gatewayConnectionTestEnabled(requiresApiKey: false, apiKey: "", isBusy: true))
    XCTAssertFalse(
      gatewayConnectionTestEnabled(requiresApiKey: true, apiKey: "   ", isBusy: false))
    XCTAssertTrue(
      gatewayConnectionTestEnabled(requiresApiKey: true, apiKey: "sk-live", isBusy: false))
    XCTAssertFalse(
      gatewayConnectionTestEnabled(requiresApiKey: true, apiKey: "sk-live", isBusy: true))
  }

  // MARK: - Accounts C9 detect-message parsing

  func testDetectMessageParsingSurvivesIdentityContainingIn() {
    XCTAssertEqual(
      accountIdentity(fromDetectionMessage: "Detected alex@studio.example in Claude Code"),
      "alex@studio.example")
    XCTAssertEqual(
      accountIdentity(fromDetectionMessage: "Detected a in b in Claude Code"),
      "a in b")
    XCTAssertEqual(
      accountIdentity(fromDetectionMessage: "Detected the current login in Codex"),
      "Current login")
    XCTAssertNil(accountIdentity(fromDetectionMessage: nil))
    XCTAssertNil(accountIdentity(fromDetectionMessage: "no prefix here"))
    XCTAssertNil(accountIdentity(fromDetectionMessage: "Detected no-source-here"))
    XCTAssertNil(accountIdentity(fromDetectionMessage: "Detected  in Claude Code"))
  }

  func testDisplayMetadataRejectsOpaqueCredentialStrings() {
    let opaque = String(repeating: "A", count: 256)
    XCTAssertNil(displaySafeIdentity(opaque))
    XCTAssertEqual(displaySafeIdentity("person@example.com"), "person@example.com")
    XCTAssertEqual(
      displaySafeFeedback("Detected \(opaque) in Gemini", fallback: "Try again."),
      "Try again."
    )
    XCTAssertNil(
      accountIdentity(fromDetectionMessage: "Detected \(opaque) in Gemini")
    )
  }

  // MARK: - Accounts C8 submit without parsed identity

  func testSavedAccountSubmitAcceptsLiveLoginWithoutIdentity() {
    // WorkBuddy token with no `sub`: live login present, identity empty.
    XCTAssertTrue(
      addSavedAccountCanSubmit(
        name: "Work", isNewAccountMode: false, hasIdentity: false, hasLiveLogin: true,
        methodAvailable: false, providerEnabled: true, isBlocked: false))
    XCTAssertFalse(
      addSavedAccountCanSubmit(
        name: "Work", isNewAccountMode: false, hasIdentity: false, hasLiveLogin: false,
        methodAvailable: false, providerEnabled: true, isBlocked: false))
    XCTAssertFalse(
      addSavedAccountCanSubmit(
        name: "   ", isNewAccountMode: false, hasIdentity: true, hasLiveLogin: true,
        methodAvailable: true, providerEnabled: true, isBlocked: false))
    XCTAssertFalse(
      addSavedAccountCanSubmit(
        name: "Work", isNewAccountMode: false, hasIdentity: true, hasLiveLogin: false,
        methodAvailable: false, providerEnabled: false, isBlocked: false))
    XCTAssertFalse(
      addSavedAccountCanSubmit(
        name: "Work", isNewAccountMode: false, hasIdentity: true, hasLiveLogin: false,
        methodAvailable: true, providerEnabled: true, isBlocked: true))
  }

  func testNewAccountSignInStillRequiresAnAvailableMethod() {
    XCTAssertTrue(
      addSavedAccountCanSubmit(
        name: "Work", isNewAccountMode: true, hasIdentity: false, hasLiveLogin: false,
        methodAvailable: true, providerEnabled: true, isBlocked: false))
    XCTAssertFalse(
      addSavedAccountCanSubmit(
        name: "Work", isNewAccountMode: true, hasIdentity: false, hasLiveLogin: false,
        methodAvailable: false, providerEnabled: true, isBlocked: false))
  }

  func testCredentialInputSubmitRequiresNameAndSecret() {
    XCTAssertTrue(
      addCredentialInputCanSubmit(
        name: "Work", secret: "sk-live", providerEnabled: true, isBlocked: false))
    XCTAssertFalse(
      addCredentialInputCanSubmit(
        name: "Work", secret: "  ", providerEnabled: true, isBlocked: false))
    XCTAssertFalse(
      addCredentialInputCanSubmit(
        name: "", secret: "sk-live", providerEnabled: true, isBlocked: false))
    XCTAssertFalse(
      addCredentialInputCanSubmit(
        name: "Work", secret: "sk-live", providerEnabled: false, isBlocked: false))
  }

  /// A local model server needs no key, so its sheet saves with the field empty.
  func testCredentialInputSubmitAcceptsNoKeyForAKeyOptionalProduct() {
    XCTAssertTrue(
      addCredentialInputCanSubmit(
        name: "Local", secret: "", providerEnabled: true, isBlocked: false, secretOptional: true))
    XCTAssertFalse(
      addCredentialInputCanSubmit(
        name: " ", secret: "", providerEnabled: true, isBlocked: false, secretOptional: true))
  }

  // MARK: - Hub H5 choice resolves the conflict away
  //
  // A pick does not linger on "Choose": selectRoutingCandidate records the
  // owner and the group publishes to it, so the conflict row disappears and
  // the model appears owned. These pin the compile() branch that verdict
  // rests on — delete the owner-publish branch and both fail. The resolving
  // spinner (H7) covers the async window in production.

  func testChoosingCandidatePublishesModelAndClearsConflict() {
    let sources = [
      DesignHubSource(
        id: "a", name: "A", detail: "", provider: "Claude", providerID: "claude", symbol: "s", enabled: true),
      DesignHubSource(
        id: "b", name: "B", detail: "", provider: "OpenAI", providerID: "openai", symbol: "s", enabled: true),
    ]
    let catalogs = [
      DesignHubCatalog(accountID: "a", catalogID: "claude", models: ["m1"]),
      DesignHubCatalog(accountID: "b", catalogID: "codex", models: ["m1"]),
    ]
    let unchosen = DesignHubRouting.compile(sources: sources, catalogs: catalogs, owners: [:])
    XCTAssertEqual(unchosen.conflicts.count, 1)
    XCTAssertTrue(
      unchosen.models.contains(where: { $0.modelID == "m1" && $0.needsChoice }))

    let chosen = DesignHubRouting.compile(
      sources: sources, catalogs: catalogs, owners: ["m1": "b"])
    XCTAssertTrue(chosen.conflicts.isEmpty)
    let published = chosen.models.first(where: { $0.modelID == "m1" })
    XCTAssertEqual(published?.ownerAccountID, "b")
    XCTAssertEqual(published?.needsChoice, false)
  }

  func testPartialChoiceLeavesOnlyUnownedModelsInConflict() {
    let sources = [
      DesignHubSource(
        id: "a", name: "A", detail: "", provider: "Claude", providerID: "claude", symbol: "s", enabled: true),
      DesignHubSource(
        id: "b", name: "B", detail: "", provider: "OpenAI", providerID: "openai", symbol: "s", enabled: true),
    ]
    let catalogs = [
      DesignHubCatalog(accountID: "a", catalogID: "claude", models: ["m1", "m2"]),
      DesignHubCatalog(accountID: "b", catalogID: "codex", models: ["m1", "m2"]),
    ]
    let partial = DesignHubRouting.compile(
      sources: sources, catalogs: catalogs, owners: ["m1": "a"])
    XCTAssertEqual(partial.conflicts.count, 1)
    XCTAssertEqual(partial.conflicts[0].models, ["m2"])
    // m2 is genuinely unchosen: "Choose" is the correct selection.
    XCTAssertNil(partial.conflicts[0].selectedCandidateID)
  }

  // MARK: - Hub H6 schemeless port parsing

  func testServicePortParsesSchemelessLoopbackAddress() {
    XCTAssertEqual(servicePort(from: "http://127.0.0.1:41401"), 41401)
    XCTAssertEqual(servicePort(from: "127.0.0.1:41401"), 41401)
    XCTAssertEqual(servicePort(from: "[::1]:5150"), 5150)
    XCTAssertEqual(servicePort(from: "http://127.0.0.1:41401/health"), 41401)
    XCTAssertNil(servicePort(from: nil))
    XCTAssertNil(servicePort(from: ""))
    XCTAssertNil(servicePort(from: "localhost"))
    XCTAssertNil(servicePort(from: "http://localhost:notaport"))
  }

  // MARK: - Hub H7 row operation keys

  /// Rotation is hub policy, not a source: it renders in the global
  /// strategy section, never inside the accounts list it governs. It never
  /// hides a source: the engine decides per request which accounts a model
  /// can be spread across.
  func testHubRotationRowLivesOutsideTheAccountsList() {
    let sources = [
      DesignHubSource(
        id: "claude-work", name: "Work", detail: "", provider: "Claude",
        symbol: "sparkle", enabled: true, hub: "default"),
      DesignHubSource(
        id: "hub/default/rotation", name: "Rotate across accounts",
        detail: "Spread each model across the accounts that serve it",
        provider: "", symbol: "arrow.triangle.2.circlepath", enabled: true,
        rotates: true, rotatesAccountCount: 2, hub: "default"),
    ]
    XCTAssertEqual(DesignHubSourceRows.visible(sources).map(\.id), ["claude-work"])
    XCTAssertEqual(DesignHubSourceRows.rotationRows(in: sources).map(\.id), ["hub/default/rotation"])
  }

  /// Same-provider accounts stay adjacent, alphabetical inside each provider
  /// group, so a many-account hub reads as provider blocks, not confetti.
  func testHubSourcesGroupByProvider() {
    let sources = [
      DesignHubSource(
        id: "codex-work", name: "Work", detail: "", provider: "OpenAI",
        symbol: "terminal", enabled: true, hub: "default"),
      DesignHubSource(
        id: "claude-work", name: "Work", detail: "", provider: "Claude",
        symbol: "sparkle", enabled: true, hub: "default"),
      DesignHubSource(
        id: "gemini-pro", name: "Pro", detail: "", provider: "Google Gemini",
        symbol: "sparkle", enabled: true, hub: "default"),
      DesignHubSource(
        id: "claude-personal", name: "Personal", detail: "", provider: "Claude",
        symbol: "sparkle", enabled: true, hub: "default"),
    ]
    XCTAssertEqual(DesignHubSourceRows.visible(sources).map(\.id), [
      "claude-personal", "claude-work", "gemini-pro", "codex-work",
    ])
  }

  /// A conflict spanning providers offers each provider ahead of the
  /// accounts: choosing "OpenAI" pins the group to the provider instead of
  /// one account. Single-provider groups stay account-only.
  func testHubConflictOffersProviderChoice() {
    let sources = [
      DesignHubSource(
        id: "a1", name: "Work", detail: "a@mail", provider: "Claude",
        providerID: "claude", symbol: "s", enabled: true, hub: "default"),
      DesignHubSource(
        id: "b1", name: "Lab", detail: "b@mail", provider: "OpenAI",
        providerID: "openai", symbol: "t", enabled: true, hub: "default"),
    ]
    let catalogs = [
      DesignHubCatalog(accountID: "a1", catalogID: "claude", models: ["m1"]),
      DesignHubCatalog(accountID: "b1", catalogID: "codex", models: ["m1"]),
    ]
    let compiled = DesignHubRouting.compile(sources: sources, catalogs: catalogs, owners: [:])
    XCTAssertEqual(compiled.conflicts.count, 1)
    let conflict = try! XCTUnwrap(compiled.conflicts.first)
    XCTAssertEqual(
      conflict.candidates.map(\.id),
      ["provider/claude", "provider/openai", "a1", "b1"])
    let providers = conflict.candidates.filter(\.providerChoice)
    XCTAssertEqual(providers.map(\.actionID), ["overlap-1:provider/claude", "overlap-1:provider/openai"])
    XCTAssertTrue(providers.allSatisfy { $0.provider == $0.id.split(separator: "/").last.map(String.init) })
    let solo = DesignHubRouting.compile(
      sources: [sources[0]],
      catalogs: [catalogs[0]],
      owners: [:])
    XCTAssertTrue(solo.conflicts.isEmpty)
  }

  /// A pool source has no account to resolve, so its row must use the engine's
  /// own label and detail: resolving it would look for an account named
  /// "pool:codex" and print that raw value to the user.
  func testPoolSourceRowDescribesItself() {
    let pool = DesignHubSource(
      id: "hub/default/codex/pool:codex", name: "All codex accounts (pool)",
      detail: "Round-robin across every codex account in this hub",
      provider: "OpenAI Codex", symbol: "terminal", enabled: true,
      poolSource: true, hub: "default")
    let account = DesignHubSource(
      id: "hub/default/codex/work", name: "Work", detail: "work@example.com",
      provider: "OpenAI Codex", symbol: "terminal", enabled: false, hub: "default")
    XCTAssertTrue(pool.describesItself)
    XCTAssertFalse(account.describesItself)
  }

  /// The row tells the model which hub it belongs to, so the mutation can name
  /// it without the view guessing.
  func testHubRotationRowCarriesItsHubAndCount() {
    let rotate = DesignHubSource(
      id: "hub/team/rotation", name: "Rotate across accounts", detail: "",
      provider: "", symbol: "arrow.triangle.2.circlepath", enabled: true,
      rotates: true, rotatesAccountCount: 3, hub: "team")
    XCTAssertTrue(rotate.rotates)
    XCTAssertEqual(rotate.rotatesAccountCount, 3)
    XCTAssertEqual(rotate.hub, "team")
  }

  /// Rotation must not be mistaken for a source: a hub whose only enabled row
  /// is the mode switch still has nothing to publish, so the empty state and
  /// the "turn on a model source" guard keep working.
  @MainActor
  func testHubRotationRowIsNotASource() {
    let model = MacOSDesignModel(
      destination: .proxyHub, phase: .ready, appearance: .system, activityShowsLogs: false,
      apps: [], accounts: [], proxies: [], activity: [], backups: [])
    model.hubSources = [
      DesignHubSource(
        id: "hub/default/rotation", name: "Rotate across accounts", detail: "",
        provider: "", symbol: "arrow.triangle.2.circlepath", enabled: true,
        rotates: true, rotatesAccountCount: 2, hub: "default")
    ]
    model.hubSourceIDs = []
    XCTAssertTrue(model.hubSourceShowsEnabled("hub/default/rotation"))
    XCTAssertFalse(model.hubSourceShowsEnabled("claude-work"))
    XCTAssertTrue(model.hubSourceIDs.isEmpty)
  }

  /// The engine sends the rotation row with two extra keys; an older engine
  /// that omits them must decode as an ordinary source, not fail.
  func testHubSourceSnapshotDecodesRotationFields() throws {
    let payload = """
    [{"id":"hub/default/rotation","providerId":"","name":"rotation",
      "label":"Rotate across accounts","detail":"Spread each model","enabled":true,
      "hub":"default","rotates":true,"accountCount":3},
     {"id":"hub/default/kiro/a","providerId":"kiro","name":"a","label":"A",
      "detail":"","enabled":false,"hub":"default"}]
    """.data(using: .utf8)!
    let rows = try JSONDecoder().decode([HubSourceSnapshot].self, from: payload)
    XCTAssertEqual(rows.count, 2)
    XCTAssertEqual(rows[0].rotates, true)
    XCTAssertEqual(rows[0].accountCount, 3)
    XCTAssertNil(rows[1].rotates)
    XCTAssertNil(rows[1].accountCount)
  }

  func testHubRowServiceKeysAreNamespaced() {
    XCTAssertEqual(hubSourceServiceID("claude-work"), "hub-source/claude-work")
    XCTAssertEqual(hubConflictServiceID("hub-source-choice-1"), "hub-conflict/hub-source-choice-1")
    XCTAssertFalse(hubSourceServiceID("x").hasPrefix("hub-conflict/"))
  }

  // MARK: - Apps A8 gateway action availability

  func testAddGatewayAvailableForClientsWithoutFirstPartyMatch() {
    // Kiro/Grok/OpenCode/WorkBuddy have no first-party gateway match; the
    // sheet's provider picker covers them, so the action stays enabled.
    XCTAssertTrue(canAddGateway(isBusy: false, gatewayProviderCount: 3))
    XCTAssertFalse(canAddGateway(isBusy: true, gatewayProviderCount: 3))
    XCTAssertFalse(canAddGateway(isBusy: false, gatewayProviderCount: 0))
  }

  // MARK: - Apps A11 attention placeholder

  private func placeholderAction(id: String, clientID: String, enabled: Bool) -> ActionSnapshot {
    ActionSnapshot(
      id: id, clientId: clientID, sourceId: "s", client: clientID, label: id,
      detail: nil, kind: "account", presentation: "app-route", selected: false,
      enabled: enabled, disabledReason: nil, routeKind: "account", modelId: nil,
      upstreamProviderId: nil, upstreamSourceLabel: nil)
  }

  private func placeholderProvider(clientID: String?, installed: Bool) -> AccountProviderSnapshot
  {
    AccountProviderSnapshot(
      id: clientID ?? "p", providerId: "claude", clientId: clientID, sourceId: nil,
      label: "Claude", detail: "", installed: installed, livePresent: nil,
      liveIdentity: nil, loginMethods: nil, canClear: nil, credentialKinds: nil)
  }

  func testAttentionPlaceholderForAllDisabledActions() {
    let disabled = [placeholderAction(id: "r1", clientID: "kiro", enabled: false)]
    XCTAssertTrue(
      appNeedsAttentionPlaceholder(
        clientID: "kiro", actions: disabled,
        providers: [placeholderProvider(clientID: "kiro", installed: false)]))
    XCTAssertFalse(
      appNeedsAttentionPlaceholder(
        clientID: "kiro",
        actions: disabled + [placeholderAction(id: "r2", clientID: "kiro", enabled: true)],
        providers: []))
    XCTAssertFalse(
      appNeedsAttentionPlaceholder(
        clientID: "kiro", actions: disabled,
        providers: [placeholderProvider(clientID: "kiro", installed: true)]))
    XCTAssertFalse(
      appNeedsAttentionPlaceholder(clientID: "ghost", actions: disabled, providers: []))
  }

  // MARK: - Apps A12 cross-provider direct-account

  func testCrossProviderDirectAccountIsARoute() {
    XCTAssertEqual(
      appRouteKind(routeKind: "direct-account", upstreamProviderID: "claude", clientID: "claude"),
      .native)
    XCTAssertEqual(
      appRouteKind(
        routeKind: "direct-account", upstreamProviderID: "anthropic", clientID: "claude"),
      .native)
    XCTAssertEqual(
      appRouteKind(routeKind: "direct-account", upstreamProviderID: "grok", clientID: "claude"),
      .account)
    XCTAssertEqual(
      appRouteKind(routeKind: "direct-account", upstreamProviderID: nil, clientID: "claude"),
      .native)
    XCTAssertEqual(
      appRouteKind(routeKind: "direct-account", upstreamProviderID: "  ", clientID: "claude"),
      .native)
    XCTAssertEqual(
      appRouteKind(routeKind: "hub", upstreamProviderID: "claude", clientID: "claude"), .hub)
    XCTAssertEqual(
      appRouteKind(routeKind: "gateway", upstreamProviderID: "openrouter", clientID: "codex"),
      .gateway)
    XCTAssertEqual(
      appRouteKind(routeKind: "pool", upstreamProviderID: "claude", clientID: "codex"), .account)
    XCTAssertEqual(
      appRouteKind(routeKind: "mystery", upstreamProviderID: "claude", clientID: "claude"),
      .account)
  }

  // MARK: - Accounts C6/C10 inline blocker reason

  func testBlockerMessageExplainsDisabledSignIn() {
    XCTAssertNil(
      addAccountBlockerMessage(
        provider: DesignProviderOption(
          id: "claude", label: "Claude", detail: "", enabled: true,
          loginMethods: [DesignLoginMethod(
            id: "oauth", label: "OAuth", detail: "", provenance: "official",
            preferred: true, available: true)]),
        method: nil,
        isNewAccountMode: false))
    let noProvider = addAccountBlockerMessage(
      provider: nil, method: nil, isNewAccountMode: false)
    XCTAssertNotNil(noProvider)
    XCTAssertTrue(noProvider?.contains("No compatible providers") == true)
    let disabled = addAccountBlockerMessage(
      provider: DesignProviderOption(
        id: "kiro", label: "Kiro", detail: "Install the kiro-cli to sign in.", enabled: false),
      method: nil,
      isNewAccountMode: false)
    XCTAssertEqual(disabled, "Install the kiro-cli to sign in.")
    let methodReason = addAccountBlockerMessage(
      provider: DesignProviderOption(id: "codex", label: "Codex", detail: "", enabled: true),
      method: DesignLoginMethod(
        id: "device", label: "Device", detail: "Browser flow", provenance: "official",
        preferred: true, available: false, unavailableReason: "Missing codex binary"),
      isNewAccountMode: true)
    XCTAssertEqual(methodReason, "Missing codex binary")
  }

  // MARK: - Activity L5 clear vs rotation

  func testVisibleLogLinesHideByCountAndResetOnRotation() {
    var hidden = 3
    XCTAssertEqual(
      visibleLogLines(["l1", "l2", "l3", "l4", "l5"], hiddenCount: &hidden),
      ["l4", "l5"])
    XCTAssertEqual(hidden, 3)

    // Rotation/restart: tail shorter than what was hidden → reset, new
    // entries visible instead of hidden forever.
    var rotated = 5
    XCTAssertEqual(visibleLogLines(["n1", "n2"], hiddenCount: &rotated), ["n1", "n2"])
    XCTAssertEqual(rotated, 0)

    // Same-length tail keeps hiding (still cleared, not a rotation —
    // only a byte offset would tell a same-length restart apart).
    var sameLength = 2
    XCTAssertEqual(visibleLogLines(["x", "y"], hiddenCount: &sameLength), [])
    XCTAssertEqual(sameLength, 2)

    // Suffix limit applies after hiding.
    var capped = 1
    let many = (1...200).map { "line\($0)" }
    XCTAssertEqual(visibleLogLines(many, hiddenCount: &capped).count, 160)
    XCTAssertEqual(visibleLogLines(many, hiddenCount: &capped).first, "line41")

    var cleared = 0
    XCTAssertEqual(visibleLogLines([], hiddenCount: &cleared), [])
  }

  // MARK: - Backups B7 all-skipped selection

  func testBackupImportSkipsReplaceWithoutOverwrite() {
    let dispositions = ["a": "ready", "b": "replace", "c": "blocked"]
    XCTAssertEqual(
      backupImportEntryIDs(
        selectedIDs: ["a", "b", "c"], dispositions: dispositions, overwrite: false),
      ["a", "c"])
    XCTAssertEqual(
      backupImportEntryIDs(
        selectedIDs: ["a", "b", "c"], dispositions: dispositions, overwrite: true),
      ["a", "b", "c"])
    // Skip-with-all-replace: empty means "nothing would change" — the caller
    // warns instead of sitting open with no feedback.
    XCTAssertEqual(
      backupImportEntryIDs(selectedIDs: ["b"], dispositions: dispositions, overwrite: false),
      [])
    XCTAssertEqual(
      backupImportEntryIDs(selectedIDs: [], dispositions: dispositions, overwrite: false),
      [])
  }

  // MARK: - Overview O1 attention covers accounts

  private func overviewProxy(id: String, status: DesignStatus) -> DesignProxy {
    DesignProxy(
      id: id, name: id, detail: "", symbol: "s", provider: "claude",
      status: status, port: 0, enabled: status == .running)
  }

  private func overviewApp(id: String, status: DesignStatus, routes: [DesignRoute] = []) -> DesignApp
  {
    DesignApp(
      id: id, name: id, detail: "", symbol: "s", status: status, accountCount: routes.count,
      selectedRouteID: routes.first?.id ?? "", routeOptions: routes,
      fastModel: "", reasoningModel: "", useCompatibleFallback: true)
  }

  private func overviewAccount(
    id: String, kind: DesignAccountKind = .saved, status: DesignStatus = .ready
  ) -> DesignAccount {
    DesignAccount(
      id: id, name: id, detail: "", provider: "Claude", symbol: "s",
      kind: kind, status: status, lastUsed: "")
  }

  private func overviewConflict(id: String, kind: DesignRoutingConflictKind) -> DesignRoutingConflict
  {
    DesignRoutingConflict(
      id: id, kind: kind, title: id, detail: "", models: ["m"], needsAttention: true,
      candidates: [])
  }

  func testAttentionTargetCoversSavedAccounts() {
    // O1 regression: account-only attention used to select nothing.
    XCTAssertEqual(
      overviewAttentionTarget(
        proxies: [overviewProxy(id: "p", status: .running)],
        apps: [overviewApp(id: "a", status: .ready)],
        accounts: [overviewAccount(id: "w", status: .attention)],
        conflicts: []),
      .account(id: "w"))
    // Priority: proxies → apps → accounts → conflicts.
    XCTAssertEqual(
      overviewAttentionTarget(
        proxies: [overviewProxy(id: "p", status: .attention)],
        apps: [overviewApp(id: "a", status: .attention)],
        accounts: [overviewAccount(id: "w", status: .attention)],
        conflicts: [overviewConflict(id: "c", kind: .sourceChoice)]),
      .proxy(id: "p"))
    XCTAssertEqual(
      overviewAttentionTarget(
        proxies: [], apps: [], accounts: [],
        conflicts: [
          overviewConflict(id: "o", kind: .modelOverlap),
          overviewConflict(id: "c", kind: .sourceChoice),
        ]),
      .conflict(kind: .sourceChoice))
    XCTAssertNil(
      overviewAttentionTarget(
        proxies: [overviewProxy(id: "p", status: .running)],
        apps: [], accounts: [overviewAccount(id: "w")], conflicts: []))
  }

  // MARK: - Overview O2/O3 checklist predicates

  func testSavedLoginExcludesGateways() {
    XCTAssertFalse(overviewHasSavedLogin(accounts: []))
    XCTAssertFalse(
      overviewHasSavedLogin(accounts: [
        overviewAccount(id: "g", kind: .gateway, status: .ready)
      ]))
    XCTAssertTrue(
      overviewHasSavedLogin(accounts: [
        overviewAccount(id: "g", kind: .gateway),
        overviewAccount(id: "w", kind: .saved),
      ]))
  }

  func testChosenRouteRequiresManagedSelection() {
    let native = DesignRoute(
      id: "native-claude", name: "Direct", detail: "", symbol: "s",
      kind: .native, providerID: "claude")
    let saved = DesignRoute(
      id: "r1", name: "Work", detail: "", symbol: "s",
      kind: .account, providerID: "claude")
    XCTAssertTrue(
      overviewHasChosenRoute(apps: [overviewApp(id: "a", status: .ready, routes: [saved, native])]))
    // Native-only login is setup still to do — in fixture and production.
    XCTAssertFalse(
      overviewHasChosenRoute(apps: [overviewApp(id: "a", status: .ready, routes: [native])]))
    XCTAssertFalse(overviewHasChosenRoute(apps: [overviewApp(id: "a", status: .ready)]))
    // Stale selection missing from the options counts for nothing.
    var stale = overviewApp(id: "a", status: .ready, routes: [saved])
    stale.selectedRouteID = "ghost"
    XCTAssertFalse(overviewIsChosenRoute(stale))
  }

  // MARK: - Overview O4/O7 service counts and summary

  func testServiceTotalSkipsPhantomHub() {
    XCTAssertEqual(
      overviewServiceTotal(proxyCount: 0, hubSourcesEmpty: true, hubEnabled: false), 0)
    XCTAssertEqual(
      overviewServiceTotal(proxyCount: 2, hubSourcesEmpty: true, hubEnabled: false), 2)
    XCTAssertEqual(
      overviewServiceTotal(proxyCount: 2, hubSourcesEmpty: false, hubEnabled: false), 3)
    XCTAssertEqual(
      overviewServiceTotal(proxyCount: 0, hubSourcesEmpty: true, hubEnabled: true), 1)
  }

  func testConnectionSummaryKeepsProductionDetail() {
    let selected = overviewApp(
      id: "a", status: .ready,
      routes: [
        DesignRoute(
          id: "r1", name: "Work", detail: "", symbol: "s",
          kind: .account, providerID: "claude")
      ])
    XCTAssertEqual(overviewConnectionSummary(selected), "Uses Work")
    var signedIn = overviewApp(id: "a", status: .ready)
    signedIn.detail = "Signed in as alex@studio.example"
    XCTAssertEqual(overviewConnectionSummary(signedIn), "Signed in as alex@studio.example")
    XCTAssertEqual(
      overviewConnectionSummary(overviewApp(id: "a", status: .ready)), "No login chosen")
  }

  // MARK: - Proxies PX3 restart parity

  func testRestartMirrorsListRow() {
    XCTAssertTrue(canRestartProxy(isRunning: true, status: .running))
    XCTAssertTrue(canRestartProxy(isRunning: false, status: .attention))
    XCTAssertTrue(canRestartProxy(isRunning: false, status: .unavailable))
    XCTAssertFalse(canRestartProxy(isRunning: false, status: .stopped))
    XCTAssertFalse(canRestartProxy(isRunning: false, status: .ready))
  }

  // MARK: - Tray T3 dismissal keys

  func testDismissalKeysOnStableID() {
    XCTAssertTrue(trayAttentionDismissed(id: "app.kiro", title: "Old copy", keys: ["app.kiro"]))
    // Legacy "id|title" keys still count: a copy change must not resurrect.
    XCTAssertTrue(
      trayAttentionDismissed(id: "app.kiro", title: "New copy", keys: ["app.kiro|Old copy"]))
    XCTAssertFalse(trayAttentionDismissed(id: "app.kiro", title: "X", keys: ["app.codex"]))
    // Pruned, and the new dismissal survives the prune.
    let full = Set((1...100).map { "k\($0)" })
    let pruned = trayDismissAttention(id: "app.kiro", keys: full)
    XCTAssertEqual(pruned.count, 100)
    XCTAssertTrue(pruned.contains("app.kiro"))
  }

  // MARK: - Tray T4 switch marks match by route id

  func testSwitchMarksMatchByRouteID() {
    let selected = "r-selected"
    XCTAssertEqual(
      traySwitchStateForRoute(
        phase: .idle, appID: "claude", routeID: selected, selectedRouteID: selected),
      .current)
    // Duplicate names across providers: the name matches, the id does not.
    XCTAssertEqual(
      traySwitchStateForRoute(
        phase: .inFlight(appID: "claude", from: "Work", to: "Work", routeID: "r-other"),
        appID: "claude", routeID: "r-work-grok", selectedRouteID: selected),
      .available)
    XCTAssertEqual(
      traySwitchStateForRoute(
        phase: .inFlight(appID: "claude", from: "Old", to: "Work", routeID: "r-work"),
        appID: "claude", routeID: "r-work", selectedRouteID: selected),
      .switching)
    XCTAssertEqual(
      traySwitchStateForRoute(
        phase: .recovery(appID: "claude", requested: "Work", kept: "Old", routeID: "r-work"),
        appID: "claude", routeID: "r-work", selectedRouteID: selected),
      .retry)
    // Another app's flight never marks this row.
    XCTAssertEqual(
      traySwitchStateForRoute(
        phase: .inFlight(appID: "codex", from: "A", to: "B", routeID: "r-work"),
        appID: "claude", routeID: "r-work", selectedRouteID: selected),
      .available)
  }

  // MARK: - Tray T6 first unused name

  func testFirstRunSaveUsesFirstUnusedName() {
    XCTAssertEqual(unusedAccountName(existing: []), "Work")
    XCTAssertEqual(unusedAccountName(existing: ["Work"]), "Personal")
    XCTAssertEqual(unusedAccountName(existing: ["work", "PERSONAL"]), "Account 3")
  }

  // MARK: - Brand marks render full color

  func testMenuBarIconUsesTheMonochromeTemplateProductMark() {
    let image = AnyPickAppIcon.menuBarImage()

    XCTAssertTrue(image.isTemplate)
    XCTAssertEqual(image.size, NSSize(width: 18, height: 18))
  }

  func testChromaticMarksRenderOriginal() {    for file in [
      "claude-mark-orange.svg", "deepseek.svg", "doubao.svg", "gemini-icon-2025.svg",
      "hunyuan.svg", "mimo.svg", "minimax.svg", "mistral.svg", "modelscope.svg",
      "nvidia.svg", "qwen.svg", "kiro-app.png", "workbuddy-mark.png", "zcode-app.png",
      "commandcode.svg",
    ] {
      XCTAssertTrue(DesignBrandAsset.rendersOriginal(file), file)
    }
    for file in [
      "claude.svg", "kimi.svg", "opencode.svg", "zai.svg", "openai.svg",
      "cline.svg", "grok-mark-dark.png", "openai-mark-light.png",
    ] {
      XCTAssertFalse(DesignBrandAsset.rendersOriginal(file), file)
    }
  }

  // The OpenAI mark is black on light and white on dark. An invented teal
  // tint read as washed out next to the full-color brand marks.
  func testOpenAIMarkTintIsMonochrome() {
    for provider in ["openai", "Codex", "codex-cli"] {
      XCTAssertEqual(DesignBrandAsset.tint(for: provider, dark: true), Color.white, provider)
      XCTAssertEqual(DesignBrandAsset.tint(for: provider, dark: false), Color.black, provider)
    }
  }

  func testProviderFallbackSymbolsCoverHubAndUnbundledProviders() {
    let providers = [
      "proxy-hub", "ark", "cerebras", "fireworks", "groq", "groq-cloud", "siliconflow",
      "stepfun", "together", "tencent-cloud-tokenhub", "hunyuan", "modelscope",
      "nvidia-nim", "doubao", "qwen", "mistral", "minimax", "kimi", "mimo", "zai",
      "cline",
    ]

    for provider in providers {
      XCTAssertNotEqual(
        DesignBrandAsset.fallbackSymbol(for: provider),
        "server.rack",
        provider
      )
    }
    XCTAssertEqual(
      DesignBrandAsset.fallbackSymbol(for: "Z.ai (GLM)"),
      "z.circle.fill"
    )
    XCTAssertEqual(
      DesignBrandAsset.fallbackSymbol(for: "cline"),
      "creditcard.fill"
    )
    XCTAssertEqual(
      DesignBrandAsset.fallbackSymbol(for: "Proxy Hub"),
      "point.3.connected.trianglepath.dotted"
    )
  }

  func testGatewayProviderDecodesEngineFlags() throws {
    // Engine keys use lowercase-d Id (requiresGatewayId/ModelId/ClientId…).
    // A capital-D Swift property silently decodes nil and hides provider
    // fields like Account ID — exactly the Cloudflare regression.
    let data = try JSONSerialization.data(withJSONObject: [
      "id": "cloudflare-aigateway",
      "label": "Cloudflare AI Gateway",
      "detail": "Unified Billing",
      "requiresApiKey": true,
      "kind": "hosted",
      "requiresGatewayId": true,
      "requiresAccountId": true,
    ])
    let row = try JSONDecoder().decode(GatewayProviderSnapshot.self, from: data)
    XCTAssertEqual(row.requiresGatewayId, true)
    XCTAssertEqual(row.requiresAccountId, true)
  }

  @MainActor
  func testFixtureStartupFlowsOpenTheirOwningPane() {
    XCTAssertEqual(
      MacOSDesignModel.fromEnvironment(["ANYPICK_MACOS_FLOW": "add-account"]).destination,
      .accounts
    )
    XCTAssertEqual(
      MacOSDesignModel.fromEnvironment(["ANYPICK_MACOS_FLOW": "published-models"]).destination,
      .apps
    )
    XCTAssertEqual(
      MacOSDesignModel.fromEnvironment(["ANYPICK_MACOS_FLOW": "restore-backup"]).destination,
      .backups
    )
  }

  @MainActor
  func testLanguagePreferenceChangesSettingsCopyImmediately() {
    let model = MacOSDesignModel(
      destination: .settings, phase: .ready, appearance: .system, activityShowsLogs: false,
      apps: [], accounts: [], proxies: [], activity: [], backups: [])

    model.setLanguage("vi")

    XCTAssertEqual(model.localized("desktop.settings.startup"), "Khởi động")
    XCTAssertEqual(model.localized("desktop.settings.language"), "Ngôn ngữ")
    XCTAssertEqual(
      model.localizedSource("Backup files contain working credentials"),
      "Tệp sao lưu chứa thông tin xác thực đang hoạt động"
    )
    XCTAssertEqual(model.localizedSource("Change Codex Connection"), "Đổi kết nối của Codex")
  }

  // MARK: - Activity L9 provider decode

  func testActivityEventDecodesProvider() throws {
    let data = try JSONSerialization.data(withJSONObject: [
      "id": "e1",
      "createdAt": "2026-09-05T12:00:00.000Z",
      "message": "Codex now uses grok/a.",
      "isError": false,
      "kind": "activation",
      "provider": "grok",
    ])
    XCTAssertEqual(try JSONDecoder().decode(ActivityEvent.self, from: data).provider, "grok")
    let legacy = try JSONSerialization.data(withJSONObject: [
      "id": "e2",
      "createdAt": "2026-09-05T12:00:00.000Z",
      "message": "Operation completed.",
      "isError": false,
      "kind": "activation",
    ])
    XCTAssertNil(try JSONDecoder().decode(ActivityEvent.self, from: legacy).provider)
  }

  // MARK: - ZCode plan warning

  func testZcodePlanWarning() throws {
    // Mirrors ~/.zcode/v2/coding-plan-cache.json: all unavailable → warn.
    let stale = try JSONSerialization.data(withJSONObject: [
      "version": 1,
      "entryStatus": ["items": [
        "builtin:zai-coding-plan": ["status": "unavailable", "reason": "coding_plan_not_authenticated"]
      ]],
    ])
    let warning = zcodeCodingPlanWarning(stale)
    XCTAssertNotNil(warning)
    XCTAssertTrue(warning?.contains("ZCode login on this Mac") == true)
    let connected = try JSONSerialization.data(withJSONObject: [
      "version": 1,
      "entryStatus": ["items": [
        "builtin:zai-coding-plan": ["status": "connected"]
      ]],
    ])
    XCTAssertNil(zcodeCodingPlanWarning(connected))
    XCTAssertNil(zcodeCodingPlanWarning(Data("garbage".utf8)))
    XCTAssertNil(zcodeCodingPlanWarning(Data("{}".utf8)))
  }

  // MARK: - Usage window cadence

  func testUsageWindowPeriodNamesCadence() {
    XCTAssertEqual(usageWindowPeriod(limitWindowSeconds: 18000), "5 hours")
    XCTAssertEqual(usageWindowPeriod(limitWindowSeconds: 604800), "week")
    XCTAssertEqual(usageWindowPeriod(limitWindowSeconds: 3600), "1 hour")
    XCTAssertEqual(usageWindowPeriod(limitWindowSeconds: 86400), "day")
    XCTAssertEqual(usageWindowPeriod(limitWindowSeconds: 1209600), "2 weeks")
    XCTAssertEqual(usageWindowPeriod(limitWindowSeconds: 90), "2 minutes")
    XCTAssertNil(usageWindowPeriod(limitWindowSeconds: nil))
    XCTAssertNil(usageWindowPeriod(limitWindowSeconds: 0))
    XCTAssertNil(usageWindowPeriod(limitWindowSeconds: -5))
  }

  func testQuotaWindowLabelAndResetFormatted() {
    let window5h = DesignUsageWindow(label: "Primary", remainingPercent: 72, limitWindowSeconds: 18000)
    XCTAssertEqual(quotaWindowLabel(window5h), "5h")

    let windowWeekly = DesignUsageWindow(label: "Secondary", remainingPercent: 41, limitWindowSeconds: 604800)
    XCTAssertEqual(quotaWindowLabel(windowWeekly), "Weekly")

    let windowMonthly = DesignUsageWindow(label: "Monthly", remainingPercent: 36, limitWindowSeconds: 2592000)
    XCTAssertEqual(quotaWindowLabel(windowMonthly), "Monthly")

    let windowSession = DesignUsageWindow(label: "Session", remainingPercent: 80)
    XCTAssertEqual(quotaWindowLabel(windowSession), "Session")

    let baseNow = Date(timeIntervalSince1970: 1700000000)
    let reset2hMs = (baseNow.timeIntervalSince1970 + 7200) * 1000
    XCTAssertEqual(quotaResetFormatted(resetsAtMs: reset2hMs, now: baseNow), "in 2h")

    let reset45mMs = (baseNow.timeIntervalSince1970 + 2700) * 1000
    XCTAssertEqual(quotaResetFormatted(resetsAtMs: reset45mMs, now: baseNow), "in 45m")

    XCTAssertEqual(quotaResetFormatted(resetsAtMs: nil, limitWindowSeconds: 18000), "every 5 hours")
  }

  func testQuotaFullyRefreshAndGroupUsageWindows() {
    let baseNow = Date(timeIntervalSince1970: 1_700_000_000)
    let resetMs = (baseNow.timeIntervalSince1970 + Double(3 * 86_400 + 19 * 3_600)) * 1000
    XCTAssertEqual(
      quotaFullyRefreshFormatted(resetsAtMs: resetMs, now: baseNow),
      "fully refresh in 3 days, 19 hours")
    XCTAssertEqual(quotaLimitAdjective(limitWindowSeconds: 604800), "weekly")
    XCTAssertEqual(quotaLimitAdjective(limitWindowSeconds: 18000), "five hour")

    let weekly = DesignUsageWindow(
      label: "Weekly Limit Remaining", remainingPercent: 95,
      limitWindowSeconds: 604800, group: "Gemini Models")
    XCTAssertEqual(quotaWindowLabel(weekly), "Weekly Limit Remaining")

    let windows = [
      DesignUsageWindow(
        label: "Weekly Limit Remaining", remainingPercent: 95,
        limitWindowSeconds: 604800, group: "Gemini Models"),
      DesignUsageWindow(
        label: "Five Hour Limit Remaining", remainingPercent: 100,
        limitWindowSeconds: 18000, group: "Gemini Models"),
      DesignUsageWindow(
        label: "Weekly Limit Remaining", remainingPercent: 48,
        limitWindowSeconds: 604800, group: "Claude and GPT models"),
      DesignUsageWindow(label: "Session", remainingPercent: 72),
    ]
    let groups = groupUsageWindows(windows)
    XCTAssertEqual(groups.map(\.title), ["Gemini Models", "Claude and GPT models", nil])
    XCTAssertEqual(groups[0].windows.map(\.remainingPercent), [95, 100])
    XCTAssertEqual(groups[1].windows.map(\.remainingPercent), [48])
    XCTAssertEqual(groups[2].windows.map(\.label), ["Session"])
  }


  // The account row's provider is a display name ("OpenAI"), while quota is
  // keyed by engine provider ("codex"). Matching on the display name dropped
  // every Codex account's remaining quota.
  @MainActor
  func testCurrentAccountUsageMatchesByProviderID() {
    let app = DesignApp(
      id: "codex", name: "Codex CLI", detail: "", symbol: "terminal.fill", status: .ready,
      accountCount: 1, selectedRouteID: "", routeOptions: [],
      fastModel: "", reasoningModel: "", useCompatibleFallback: true,
      usageWindows: [DesignUsageWindow(label: "Weekly", remainingPercent: 64)])
    let current = DesignAccount(
      id: "codex/work", name: "work", detail: "maya@studio.example", provider: "OpenAI",
      symbol: "terminal.fill", kind: .saved, status: .running, lastUsed: "Used now",
      providerID: "codex")
    let saved = DesignAccount(
      id: "codex/oss", name: "oss", detail: "oss@studio.example", provider: "OpenAI",
      symbol: "terminal.fill", kind: .saved, status: .ready, lastUsed: "Saved",
      providerID: "codex")
    let model = MacOSDesignModel(
      destination: .accounts, phase: .ready, appearance: .system, activityShowsLogs: false,
      apps: [app], accounts: [current, saved], proxies: [], activity: [], backups: [])

    XCTAssertEqual(model.usageWindows(for: current).map(\.remainingPercent), [64])
    XCTAssertTrue(model.usageWindows(for: saved).isEmpty)
  }

  @MainActor
  func testProductionAccountQuotaDoesNotDependOnInstalledApps() async throws {
    let (store, model, _) = makeProductionHarness()
    let windows: [[String: Any]] = [
      ["label": "5h", "remainingPercent": 54, "limitWindowSeconds": 18000],
      ["label": "Weekly", "remainingPercent": 34, "limitWindowSeconds": 604800],
      ["label": "Fable · Weekly", "remainingPercent": 58, "limitWindowSeconds": 604800],
    ]
    let payload: [String: Any] = [
      "revision": 1, "proxyCount": 0, "routes": [], "actions": [], "proxies": [],
      "accounts": [
        ["id": "claude/work", "providerId": "claude", "name": "work", "label": "work", "detail": "", "active": true, "canRefresh": true, "switchActionId": ""],
        ["id": "gemini/work", "providerId": "gemini", "name": "work", "label": "work", "detail": "", "active": true, "canRefresh": true, "switchActionId": ""],
        ["id": "claude/other", "providerId": "claude", "name": "other", "label": "other", "detail": "", "active": false, "canRefresh": true, "switchActionId": ""],
      ],
      "usage": [
        ["providerId": "claude", "client": "Claude", "account": "work", "windows": windows],
        ["providerId": "gemini", "client": "Gemini", "account": "work", "windows": [["label": "Weekly Limit Remaining", "remainingPercent": 73, "group": "Gemini models", "limitWindowSeconds": 604800]]],
      ],
      "gateways": [], "accountProviders": [], "gatewayProviders": [], "activity": [],
      "settings": ["launchAtLogin": false, "startEnabledProxies": false, "showQuota": true, "quotaGuardEnabled": false],
    ]
    store.consume(Data((try frame("snapshot", payload) + "\n").utf8))
    await waitUntil(model.accountUsage?["claude/work"]?.count == 3)
    XCTAssertTrue(model.apps.isEmpty)
    let claude = try XCTUnwrap(model.accounts.first { $0.id == "claude/work" })
    let gemini = try XCTUnwrap(model.accounts.first { $0.id == "gemini/work" })
    let other = try XCTUnwrap(model.accounts.first { $0.id == "claude/other" })
    XCTAssertEqual(model.usageWindows(for: claude).map(\.remainingPercent), [54, 34, 58])
    XCTAssertEqual(model.usageWindows(for: gemini).map(\.remainingPercent), [73])
    XCTAssertTrue(model.usageWindows(for: other).isEmpty)
    XCTAssertEqual(localizedQuotaWindowLabel(model.usageWindows(for: claude)[2], using: model), "Fable · Weekly")
  }

  // Welcome's Add Login… must land on the Add sheet in Accounts. The sheet's
  // isPresented binding calls dismissFirstRunWelcome again as it closes; that
  // second call used to reset the destination to Overview.
  @MainActor
  func testWelcomeAddLoginRequestsAddSheetOnAccounts() {
    let model = MacOSDesignModel(
      destination: .overview, phase: .ready, appearance: .system, activityShowsLogs: false,
      apps: [], accounts: [], proxies: [], activity: [], backups: [])
    model.showFirstRunWelcome = true

    model.addLoginFromWelcome()
    model.dismissFirstRunWelcome()

    XCTAssertFalse(model.showFirstRunWelcome)
    XCTAssertEqual(model.destination, .accounts)
    XCTAssertTrue(model.addLoginRequested)
  }

  @MainActor
  func testWelcomeNotNowStaysOnOverviewWithoutAddRequest() {
    let model = MacOSDesignModel(
      destination: .overview, phase: .ready, appearance: .system, activityShowsLogs: false,
      apps: [], accounts: [], proxies: [], activity: [], backups: [])
    model.showFirstRunWelcome = true

    model.dismissFirstRunWelcome()

    XCTAssertEqual(model.destination, .overview)
    XCTAssertFalse(model.addLoginRequested)
  }

  /// The engine's stdout arrives in chunks, and a frame is usually larger than
  /// one read. Chunks must reach the protocol client in arrival order: a
  /// task-per-chunk hand-off serviced them out of order, which desynchronized
  /// the line framing and surfaced as "the service sent an unexpected frame".
  func testFrameChunkBufferDrainsInArrivalOrder() {
    let buffer = FrameChunkBuffer()
    XCTAssertTrue(buffer.enqueue(Data("snap".utf8)), "the first chunk owns the drain")
    XCTAssertFalse(buffer.enqueue(Data("shot\t".utf8)), "a queued chunk must not start a second drain")
    XCTAssertFalse(buffer.enqueue(Data("payload\n".utf8)))

    var drained = Data()
    while let chunk = buffer.next() { drained.append(chunk) }
    XCTAssertEqual(String(decoding: drained, as: UTF8.self), "snapshot\tpayload\n")

    // A chunk enqueued while the last drain is running is picked up, not lost.
    XCTAssertTrue(buffer.enqueue(Data("next".utf8)))
    XCTAssertEqual(buffer.next(), Data("next".utf8))
    XCTAssertNil(buffer.next())
    XCTAssertTrue(buffer.enqueue(Data("again".utf8)), "the drain flag must reset")
  }

  /// Concurrent producers must not interleave a frame: whatever order the
  /// chunks were appended in is the order they are consumed in.
  func testFrameChunkBufferKeepsOrderUnderConcurrentProducers() {
    let buffer = FrameChunkBuffer()
    let producers = 8
    DispatchQueue.concurrentPerform(iterations: producers) { index in
      _ = buffer.enqueue(Data(("chunk-\(index);").utf8))
    }
    var drained = ""
    while let chunk = buffer.next() { drained += String(decoding: chunk, as: UTF8.self) }
    let pieces = drained.split(separator: ";").filter { !$0.isEmpty }
    XCTAssertEqual(pieces.count, producers)
    XCTAssertEqual(Set(pieces).count, producers, "each producer's chunk appears exactly once")
  }

  // MARK: - Structured engine failures

  func testCommandResultRendersSuggestionsAndPartialChangeWarning() throws {
    // The engine sends structure so the app can explain a failure instead of
    // repeating one sentence. A partial change is the part a user must act on,
    // so it is rendered even when the engine sent no suggestions.
    let payload: [String: Any] = [
      "version": 1,
      "requestId": "r1",
      "status": "error",
      "message": "Could not start the proxy.",
      "code": "PROXY_START_FAILED",
      "suggestions": ["Check that port 8787 is free.", "Run `anypick doctor`."],
      "mutated": true,
    ]
    let data = try JSONSerialization.data(withJSONObject: payload)
    let result = try JSONDecoder().decode(CommandResult.self, from: data)
    let text = try XCTUnwrap(result.displayMessage)

    XCTAssertTrue(text.contains("Could not start the proxy."))
    XCTAssertTrue(text.contains("partially changed"), text)
    XCTAssertTrue(text.contains("Check that port 8787 is free."), text)
    XCTAssertTrue(text.contains("Run `anypick doctor`."), text)
  }

  func testCommandResultWithoutStructureKeepsItsPlainMessage() throws {
    // A success frame stays exactly one line: no empty suggestion bullets.
    let payload: [String: Any] = [
      "version": 1, "requestId": "r1", "status": "success", "message": "Switched.",
    ]
    let data = try JSONSerialization.data(withJSONObject: payload)
    let result = try JSONDecoder().decode(CommandResult.self, from: data)
    XCTAssertEqual(result.displayMessage, "Switched.")
  }

  @MainActor
  func testAnUnreadableStateFrameIsReportedInsteadOfIgnored() async throws {
    // The state channel is the app's only source of truth. A payload this
    // build cannot decode used to be dropped, leaving "Starting…" on screen
    // forever with no explanation; now it is reported and the pane is honest.
    let (store, _, _) = makeProductionHarness()
    store.consume(Data((try frame("snapshot", ["revision": "not-a-number"]) + "\n").utf8))

    XCTAssertFalse(store.snapshotReady)
    XCTAssertTrue(store.messageIsError)
    guard case .degraded(let reason) = store.serviceState else {
      return XCTFail("an unreadable state frame must degrade the connection, got \(store.serviceState)")
    }
    XCTAssertTrue(reason.contains("state"), reason)
  }

  @MainActor
  func testAnUnreadableFrameIsReportedOncePerKind() async throws {
    // The engine re-sends state every 2.5s. Repeating the message every tick
    // would replace every real status with the same error.
    let (store, _, _) = makeProductionHarness()
    for _ in 0..<3 {
      store.consume(Data((try frame("snapshot", ["revision": "not-a-number"]) + "\n").utf8))
    }
    let first = store.message
    XCTAssertNotNil(first)
    store.consume(Data((try frame("snapshot", ["revision": "still-not-a-number"]) + "\n").utf8))
    XCTAssertEqual(store.message, first)
  }

  @MainActor
  func testAnUnreadableOptionalFrameDoesNotDegradeTheConnection() async throws {
    // Only the state channel is load-bearing. A bad backup-preview must not
    // take the whole app down with it.
    let (store, _, _) = makeProductionHarness()
    store.consume(Data((try frame("backup-preview", ["version": "nope"]) + "\n").utf8))

    XCTAssertTrue(store.messageIsError)
    if case .degraded = store.serviceState {
      XCTFail("an optional frame must not degrade the connection")
    }
  }

  @MainActor
  func testProtocolErrorReleasesTheMutationSlot() async throws {
    // The engine refuses a whole frame and will never answer it. Leaving the
    // single-flight slot held kept the sheet that sent it permanently busy.
    let (store, _, box) = makeProductionHarness()
    store.consume(Data((try accountSnapshotFrame() + "\n").utf8))
    await waitUntil(store.snapshotReady)
    store.attachCommandSink { box.lines.append($0) }
    XCTAssertNotNil(
      store.mutate(
        operation: "account-refresh", name: "Work", providerId: "claude",
        activityLabel: "refreshing Work"))
    XCTAssertNotNil(store.busyRequestId)

    store.consume(
      Data(
        (try frame(
          "protocol-error",
          ["protocolVersion": 2, "code": "MALFORMED_FRAME", "message": "command frame was rejected"]
        ) + "\n").utf8))

    XCTAssertNil(store.busyRequestId)
    XCTAssertTrue(store.messageIsError)
    XCTAssertEqual(store.message, "command frame was rejected")
  }

  @MainActor
  func testUnreadableResultFrameReleasesTheMutationSlot() async throws {
    // A DTO drift between the app and its bundled engine used to make the
    // decode fail, drop the frame, and leave the spinner running forever.
    let (store, _, box) = makeProductionHarness()
    store.consume(Data((try accountSnapshotFrame() + "\n").utf8))
    await waitUntil(store.snapshotReady)
    store.attachCommandSink { box.lines.append($0) }
    XCTAssertNotNil(
      store.mutate(
        operation: "account-refresh", name: "Work", providerId: "claude",
        activityLabel: "refreshing Work"))
    let requestID = try XCTUnwrap(store.busyRequestId)

    // `status` is required by this build's decoder; the frame is otherwise a
    // well-formed result for the request that is in flight.
    store.consume(
      Data(
        (try frame("result", ["version": 1, "requestId": requestID, "message": "done"])
          + "\n").utf8))

    XCTAssertNil(store.busyRequestId)
    XCTAssertTrue(store.messageIsError)
    // The frame that owned this request cannot be read, so the operation must
    // settle from here: releasing the slot alone left every sheet that waits on
    // operationResult showing progress forever.
    XCTAssertEqual(store.lastResult?.requestId, requestID)
    XCTAssertEqual(store.lastResult?.status, "error")
    XCTAssertEqual(store.lastResult?.code, "UNREADABLE_RESULT")
  }

  @MainActor
  func testStructuredFailureReachesTheErrorAlert() async throws {
    let (store, model, _) = makeProductionHarness()
    store.consume(Data((try accountSnapshotFrame() + "\n").utf8))
    await waitUntil(store.snapshotReady)

    store.mutate(
      operation: "account-refresh", name: "Work", providerId: "claude",
      activityLabel: "refreshing Work")
    let requestID = try XCTUnwrap(store.busyRequestId)
    store.consume(
      Data(
        (try frame(
          "result",
          [
            "version": 1,
            "requestId": requestID,
            "status": "error",
            "message": "The upstream rejected the stored key.",
            "code": "PROXY_UPSTREAM_FAILED",
            "suggestions": ["Save a valid API key, then try again."],
          ]) + "\n").utf8))
    await waitUntil(model.feedback?.message.contains("Save a valid API key") == true)

    XCTAssertEqual(model.feedback?.kind, .error)
    XCTAssertTrue(
      model.feedback?.message.contains("The upstream rejected the stored key.") == true,
      model.feedback?.message ?? "no feedback")
  }

  // MARK: - Takeover consent (CLIENT_CONFIG_FOREIGN)

  @MainActor
  func testForeignKeyRefusalOffersTheTakeoverConfirmation() async throws {
    // The engine fails closed when a client's config holds values it does not
    // own, and the message tells the user to confirm the takeover. Before this
    // there was nothing to confirm with, so the refusal was a dead end.
    let (store, model, _) = makeProductionHarness()
    store.consume(Data((try accountSnapshotFrame() + "\n").utf8))
    await waitUntil(store.snapshotReady)

    store.invoke(actionId: "route-1", label: "Claude Code · Work")
    let requestID = try XCTUnwrap(store.busyRequestId)
    store.consume(
      Data(
        (try frame(
          "result",
          [
            "version": 1,
            "requestId": requestID,
            "status": "error",
            "message": "claude config contains settings not managed by AnyPick.",
            "code": "CLIENT_CONFIG_FOREIGN",
            "suggestions": ["Re-run with --allow-foreign-config to back up and replace these settings."],
          ]) + "\n").utf8))
    await waitUntil(model.pendingTakeover != nil)

    XCTAssertEqual(model.pendingTakeover?.id, requestID)
    XCTAssertEqual(model.feedback?.kind, .error)
  }

  @MainActor
  func testConfirmingTakeoverReinvokesTheSameActionWithConsent() async throws {
    let (store, model, box) = makeProductionHarness()
    store.consume(Data((try accountSnapshotFrame() + "\n").utf8))
    await waitUntil(store.snapshotReady)

    store.invoke(actionId: "route-1", label: "Claude Code · Work")
    let refused = try XCTUnwrap(store.busyRequestId)
    store.consume(
      Data(
        (try frame(
          "result",
          [
            "version": 1, "requestId": refused, "status": "error",
            "message": "claude config contains settings not managed by AnyPick.",
            "code": "CLIENT_CONFIG_FOREIGN",
          ]) + "\n").utf8))
    await waitUntil(model.pendingTakeover != nil)
    let sentBefore = box.lines.count

    model.confirmPendingTakeover()

    XCTAssertNil(model.pendingTakeover)
    XCTAssertEqual(box.lines.count, sentBefore + 1)
    let line = try XCTUnwrap(box.lines.last)
    XCTAssertTrue(line.hasPrefix("invoke\t"), line)
    guard let encoded = line.split(separator: "\t", maxSplits: 1).last,
          let data = Data(base64Encoded: String(encoded)) else {
      return XCTFail("takeover retry was not framed")
    }
    let payload = try XCTUnwrap(
      try JSONSerialization.jsonObject(with: data) as? [String: Any])
    XCTAssertEqual(payload["actionId"] as? String, "route-1")
    XCTAssertEqual(payload["allowForeignConfig"] as? Bool, true)
    // A fresh request id: the engine keys results on it, and reusing the
    // refused one would make the retry indistinguishable from its own failure.
    XCTAssertNotEqual(payload["requestId"] as? String, refused)
  }

  @MainActor
  func testAnUnconfirmedInvokeNeverAsksForConsent() async throws {
    // The flag must be absent, not false: an engine that sees the key at all
    // could read a defaulted `false` as an answer nobody gave.
    let (store, _, box) = makeProductionHarness()
    store.consume(Data((try accountSnapshotFrame() + "\n").utf8))
    await waitUntil(store.snapshotReady)

    store.invoke(actionId: "route-1", label: "Claude Code · Work")

    guard let encoded = box.lines.first?.split(separator: "\t", maxSplits: 1).last,
          let data = Data(base64Encoded: String(encoded)),
          let payload = try JSONSerialization.jsonObject(with: data) as? [String: Any]
    else {
      return XCTFail("invoke was not framed")
    }
    XCTAssertNil(payload["allowForeignConfig"])
  }

  @MainActor
  func testATakeoverOfferNeverReplaysADifferentAction() async throws {
    // Consent is granted for one refused action. If another mutation claims the
    // slot afterwards, the stale offer must not become consent to replay the
    // older action — that would be the unasked-for takeover the gate prevents.
    let (store, model, box) = makeProductionHarness()
    store.consume(Data((try accountSnapshotFrame() + "\n").utf8))
    await waitUntil(store.snapshotReady)

    store.invoke(actionId: "route-1", label: "Claude Code · Work")
    let refused = try XCTUnwrap(store.busyRequestId)
    store.consume(
      Data(
        (try frame(
          "result",
          [
            "version": 1, "requestId": refused, "status": "error",
            "message": "claude config contains settings not managed by AnyPick.",
            "code": "CLIENT_CONFIG_FOREIGN",
          ]) + "\n").utf8))
    await waitUntil(model.pendingTakeover != nil)

    // A different command runs and clears the slot.
    store.mutate(
      operation: "account-refresh", name: "Work", providerId: "claude",
      activityLabel: "refreshing Work")
    let sentBefore = box.lines.count

    XCTAssertNil(store.retryInvokeWithConsent(requestId: "some-other-request"))
    XCTAssertEqual(box.lines.count, sentBefore)
  }

  @MainActor
  func testDismissingAnErrorClearsAStaleTakeoverOffer() async throws {
    let (store, model, _) = makeProductionHarness()
    store.consume(Data((try accountSnapshotFrame() + "\n").utf8))
    await waitUntil(store.snapshotReady)
    store.invoke(actionId: "route-1", label: "Claude Code · Work")
    let requestID = try XCTUnwrap(store.busyRequestId)
    store.consume(
      Data(
        (try frame(
          "result",
          [
            "version": 1, "requestId": requestID, "status": "error",
            "message": "claude config contains settings not managed by AnyPick.",
            "code": "CLIENT_CONFIG_FOREIGN",
          ]) + "\n").utf8))
    await waitUntil(model.pendingTakeover != nil)

    model.dismissFeedback()

    XCTAssertNil(model.pendingTakeover)
    XCTAssertNil(model.feedback)
  }

  // MARK: - Edit-sheet wait race (A1)

  @MainActor
  func testEditAccountRefusedWhileBusySendsNothingToWaitOn() async throws {
    // The edit sheet arms its wait only on accept. A refused mutation must
    // report false and send nothing, so no result can ever arrive to end it.
    let (store, model, box) = makeProductionHarness()
    store.consume(Data((try accountSnapshotFrame() + "\n").utf8))
    await waitUntil(model.accounts.contains { $0.id == "acc-1" })
    XCTAssertTrue(model.accounts.contains { $0.id == "acc-1" })
    // Occupy the single-flight slot.
    XCTAssertNotNil(
      store.mutate(
        operation: "account-refresh", name: "Work", providerId: "claude",
        activityLabel: "refreshing Work"))
    let sentBefore = box.lines.count
    XCTAssertFalse(model.updateAccount(id: "acc-1", label: "Renamed"))
    XCTAssertEqual(box.lines.count, sentBefore)
    XCTAssertNil(model.operationResult)
  }

  @MainActor
  func testEditAccountAcceptedTracksMutation() async throws {
    let (store, model, box) = makeProductionHarness()
    store.consume(Data((try accountSnapshotFrame() + "\n").utf8))
    await waitUntil(model.accounts.contains { $0.id == "acc-1" })
    XCTAssertTrue(model.updateAccount(id: "acc-1", label: "Renamed"))
    XCTAssertEqual(box.lines.count, 1)
    XCTAssertTrue(box.lines[0].hasPrefix("mutate\t"))
    XCTAssertNotNil(store.busyRequestId)
  }

  @MainActor
  func testAccountSwitchAcceptedTracksTheSavedAccountAction() async throws {
    let (store, model, box) = makeProductionHarness()
    store.consume(Data((try accountSnapshotFrame() + "\n").utf8))
    await waitUntil(model.accounts.contains { $0.id == "acc-1" })

    model.makeAccountCurrent(id: "acc-1")

    XCTAssertEqual(box.lines.count, 1)
    guard let encoded = box.lines.first?.split(separator: "\t", maxSplits: 1).last,
          let data = Data(base64Encoded: String(encoded)) else {
      return XCTFail("account switch command was not framed")
    }
    let payload = try XCTUnwrap(
      try JSONSerialization.jsonObject(with: data) as? [String: Any])
    XCTAssertEqual(payload["actionId"] as? String, "switch-1")
    XCTAssertEqual(payload["revision"] as? Int, 1)
    XCTAssertEqual(model.switchingAccountID, "acc-1")

    let requestID = try XCTUnwrap(store.busyRequestId)
    store.consume(
      Data(
        (try frame(
          "result",
          ["version": 1, "requestId": requestID, "status": "success", "message": "Switched."]
        ) + "\n").utf8))
    await waitUntil(model.feedback?.message == "Switched.")
    XCTAssertFalse(model.isBusy)
    XCTAssertNil(model.switchingAccountID)
  }

  @MainActor
  func testAccountSwitchRejectedByUnavailableServiceIsSurfaced() async throws {
    let (store, model, _) = makeProductionHarness()
    store.consume(Data((try accountSnapshotFrame() + "\n").utf8))
    await waitUntil(model.accounts.contains { $0.id == "acc-1" })
    store.updateServiceState(.degraded("The bundled service stopped."))

    model.makeAccountCurrent(id: "acc-1")

    XCTAssertFalse(model.isBusy)
    XCTAssertNil(model.switchingAccountID)
    XCTAssertEqual(
      model.feedback?.message,
      "AnyPick service is unavailable. The bundled service stopped."
    )
  }

  @MainActor
  func testServiceFailureCompletesPendingAccountSaveWithError() async throws {
    let (store, model, _) = makeProductionHarness()
    store.consume(Data((try accountSnapshotFrame() + "\n").utf8))
    await waitUntil(store.snapshotReady)

    XCTAssertTrue(
      model.addSavedAccount(
        provider: "claude", name: "Another", label: "", identity: "Current login"
      )
    )
    guard let requestID = store.busyRequestId else {
      return XCTFail("account save did not claim the mutation slot")
    }

    store.updateServiceState(.degraded("The bundled service stopped."))
    await waitUntil(model.operationResult?.requestID == requestID)

    XCTAssertFalse(model.isBusy)
    XCTAssertEqual(model.operationResult?.operation, "account-save")
    XCTAssertEqual(model.operationResult?.succeeded, false)
    XCTAssertEqual(model.operationResult?.message, "The bundled service stopped.")
  }

  @MainActor
  func testLoginSendsSelectedGeminiMethodAndSource() async throws {
    let (store, model, box) = makeProductionHarness()
    store.consume(Data((try geminiLoginSnapshotFrame() + "\n").utf8))
    await waitUntil(store.snapshotReady)

    XCTAssertTrue(
      model.loginSavedAccount(
        provider: "Gemini",
        name: "Work",
        label: "",
        methodId: "antigravity-subscription"
      )
    )
    XCTAssertEqual(box.lines.count, 1)
    guard let encoded = box.lines.first?.split(separator: "\t", maxSplits: 1).last,
          let data = Data(base64Encoded: String(encoded)) else {
      return XCTFail("account-login command was not framed")
    }
    let payload = try XCTUnwrap(
      try JSONSerialization.jsonObject(with: data) as? [String: Any])
    XCTAssertEqual(payload["operation"] as? String, "account-login")
    XCTAssertEqual(payload["providerId"] as? String, "gemini")
    XCTAssertEqual(payload["sourceId"] as? String, "antigravity")
    XCTAssertEqual(payload["methodId"] as? String, "antigravity-subscription")
  }

  @MainActor
  func testLoginFailureFromUnavailableServiceIsSurfaced() async throws {
    let (store, model, box) = makeProductionHarness()
    store.consume(Data((try geminiLoginSnapshotFrame() + "\n").utf8))
    await waitUntil(store.snapshotReady)
    store.updateServiceState(.degraded("The bundled service stopped."))

    XCTAssertFalse(
      model.loginSavedAccount(
        provider: "Gemini",
        name: "Work",
        label: "",
        methodId: "antigravity-subscription"
      )
    )
    XCTAssertTrue(box.lines.isEmpty)
    XCTAssertEqual(
      model.feedback?.message,
      "AnyPick service is unavailable. The bundled service stopped."
    )
  }

  @MainActor
  func testStoreDoesNotClaimActionWhenServiceIsUnavailable() {
    let (store, _, box) = makeProductionHarness()
    store.updateServiceState(.degraded("The bundled service stopped."))

    XCTAssertNil(store.invoke(actionId: "route-1", label: "DeepSeek Harness · Work"))
    XCTAssertNil(store.busyRequestId)
    XCTAssertTrue(box.lines.isEmpty)
    XCTAssertTrue(store.messageIsError)
  }

  /// A command that dies engine-side answers with a protocol error naming its
  /// request, and the row that sent it must settle on that answer: the previous
  /// behaviour ran the switch to the host's 15-second confirm timeout and told
  /// the user "did not confirm in time" instead of what the engine said.
  /// A successful conflict pick must stop its spinner at the result. This row
  /// has no snapshot state to confirm against, so waiting for one raised
  /// "didn't confirm in time" 15 seconds after every successful choice.
  @MainActor
  func testConflictPickSuccessStopsTheSpinner() async throws {
    let (store, model, _) = makeProductionHarness()
    store.consume(Data((try frame("snapshot", makeHubConflictSnapshotFrame()) + "\n").utf8))
    await waitUntil(!model.routingConflicts.isEmpty)
    guard let conflict = model.routingConflicts.first,
          let candidate = conflict.candidates.first
    else { return XCTFail("no routing conflict in the snapshot") }

    model.selectRoutingCandidate(actionID: candidate.actionID)
    guard let requestID = store.busyRequestId else {
      return XCTFail("the pick did not claim the mutation slot")
    }
    let rowID = hubConflictServiceID(conflict.id)
    XCTAssertNotNil(model.serviceOperations[rowID])

    store.consume(
      Data((try frame("result", [
        "version": 1, "requestId": requestID, "status": "success",
      ]) + "\n").utf8)
    )
    await waitUntil(model.serviceOperations[rowID] == nil)
    XCTAssertNil(model.serviceOperations[rowID])
    XCTAssertNil(model.serviceFailures[rowID])
  }

  /// An unreadable optional frame must not release the mutation slot: the save
  /// or switch that was running then loses its own ticket and never settles.
  @MainActor
  func testUnreadableLogFrameDoesNotReleaseTheMutationSlot() async throws {
    let (store, _, box) = makeProductionHarness()
    store.consume(Data((try frame("snapshot", makeHubConflictSnapshotFrame()) + "\n").utf8))
    store.requestLogs(try XCTUnwrap(store.logSources.first))

    guard let requestID = store.mutate(
      operation: "hub-rotation", name: "default", enabled: true,
      activityLabel: "updating Proxy Hub rotation") else {
      return XCTFail("mutation was refused")
    }
    XCTAssertEqual(store.busyRequestId, requestID)

    // An unreadable logs frame releases the log slot and nothing else: the
    // mutation keeps its slot, and a later real result still settles it.
    store.consume(Data("logs\tnot-base64\n".utf8))
    XCTAssertEqual(store.busyRequestId, requestID)
    let before = box.lines.filter { $0.hasPrefix("logs\t") }.count
    store.requestLogs(try XCTUnwrap(store.logSources.first))
    await waitUntil(box.lines.filter { $0.hasPrefix("logs\t") }.count > before)
    XCTAssertGreaterThan(
      box.lines.filter { $0.hasPrefix("logs\t") }.count, before,
      "an unreadable logs frame must free the log slot, not the mutation slot")

    store.consume(
      Data((try frame("result", [
        "version": 1, "requestId": requestID, "status": "success",
      ]) + "\n").utf8)
    )
    await waitUntil(store.lastResult?.requestId == requestID)
    XCTAssertEqual(store.lastResult?.requestId, requestID)
  }

  /// A rejected log request releases its own slot immediately, and says why:
  /// otherwise log polling is blocked until the 10s timeout and the message
  /// blames the wrong thing.
  @MainActor
  func testNamedProtocolErrorReleasesTheLogSlot() async throws {
    let (store, _, box) = makeProductionHarness()
    store.updateServiceState(.ready)
    store.consume(Data((try frame("snapshot", makeHubConflictSnapshotFrame()) + "\n").utf8))
    guard let source = store.logSources.first else {
      return XCTFail("snapshot carries no log sources")
    }

    store.requestLogs(source)
    guard let requestID = try lastLogRequestID(in: box) else {
      return XCTFail("no log request was sent")
    }
    store.consume(
      Data((try frame("protocol-error", [
        "protocolVersion": 2, "code": "MALFORMED_FRAME",
        "message": "command frame was rejected", "requestId": requestID,
      ]) + "\n").utf8)
    )
    XCTAssertEqual(store.message, "command frame was rejected")

    // The slot is free: a second request goes out instead of being dropped.
    let before = box.lines.filter { $0.hasPrefix("logs\t") }.count
    store.requestLogs(source)
    await waitUntil(box.lines.filter { $0.hasPrefix("logs\t") }.count > before)
    XCTAssertGreaterThan(box.lines.filter { $0.hasPrefix("logs\t") }.count, before)
  }

  /// Losing the service must not leave state that claims work is still running:
  /// spinners, optimistic switches, a stuck "Importing…" sheet, and an app that
  /// looks healthy while its engine is gone.
  @MainActor
  func testServiceDegradedFailsEveryPendingRowAndNamesItself() async throws {
    let (store, model, _) = makeProductionHarness()
    store.consume(Data((try frame("snapshot", makeHubSnapshotFrame()) + "\n").utf8))
    model.setHubRotation("default", enabled: true)
    XCTAssertFalse(model.serviceOperations.isEmpty)
    model.pendingTakeover = DesignTakeoverOffer(id: "takeover-1")

    store.updateServiceState(.degraded("The bundled service stopped."))
    await waitUntil(model.serviceOperations.isEmpty)

    XCTAssertTrue(model.serviceOperations.isEmpty)
    XCTAssertFalse(model.hubSourceShowsEnabled("hub/default/rotation"))
    XCTAssertNil(model.pendingTakeover, "a refusal cannot be answered by a dead service")
    XCTAssertEqual(
      model.serviceFailures["hub-source/hub/default/rotation"],
      "The bundled service stopped.",
      "the row that stopped answering must say why, not only the banner")
    XCTAssertTrue(
      model.degradedConditions.contains { $0.id == "service-connection" },
      "a dead engine must name itself in Needs Attention")
  }

  /// A backup import whose service died stays "Importing…" forever otherwise:
  /// the sheet's primary is disabled and nothing reports the failure.
  @MainActor
  func testServiceDegradedFailsAStuckBackupImport() async throws {
    let (store, model, _) = makeProductionHarness()
    store.consume(Data((try frame("snapshot", makeHubSnapshotFrame()) + "\n").utf8))
    model.backupInspectionState = .importing

    store.updateServiceState(.degraded("The bundled service stopped."))
    await waitUntil({
      if case .atomicFailure = model.backupInspectionState { return true }
      return false
    }())
    guard case .atomicFailure = model.backupInspectionState else {
      return XCTFail("import stayed in \(model.backupInspectionState)")
    }
    XCTAssertEqual(model.backupInspectionMessage, "The bundled service stopped.")
  }

  /// The request id of the last log frame the store emitted.
  private func lastLogRequestID(in box: CommandBox) throws -> String? {
    guard let line = box.lines.last(where: { $0.hasPrefix("logs\t") }) else { return nil }
    let encoded = line.dropFirst("logs\t".count)
    guard let data = Data(base64Encoded: String(encoded)),
          let object = try JSONSerialization.jsonObject(with: data) as? [String: Any]
    else { return nil }
    return object["requestId"] as? String
  }

  /// The strategy picker names the mode, so soonest-reset is not squeezed
  /// through the round-robin flag; `enabled` still rides along for an engine
  /// that predates the name.
  @MainActor
  func testHubStrategyPickerSendsTheNamedStrategy() async throws {
    let (store, model, box) = makeProductionHarness()
    store.consume(Data((try frame("snapshot", makeHubSnapshotFrame()) + "\n").utf8))
    await waitUntil(!model.hubSources.isEmpty)

    model.setHubStrategy("default", strategy: "soonest-reset")
    let payload = try mutatePayload(in: box.lines, operation: "hub-rotation")
    XCTAssertEqual(payload["strategy"] as? String, "soonest-reset")
    XCTAssertEqual(payload["enabled"] as? Bool, false)
    XCTAssertEqual(payload["name"] as? String, "default")
    // The pick shows at once, before the snapshot confirms it.
    XCTAssertEqual(model.hubStrategy("hub/default/rotation"), "soonest-reset")
  }

  @MainActor
  func testNamedProtocolErrorSettlesThePendingOperation() async throws {
    let (store, model, _) = makeProductionHarness()
    let hub = makeHubSnapshotFrame()
    store.consume(Data((try frame("snapshot", hub) + "\n").utf8))

    model.setHubRotation("default", enabled: true)
    guard let requestID = store.busyRequestId else {
      return XCTFail("rotation did not claim the mutation slot")
    }
    let rotationRow = "hub-source/hub/default/rotation"
    XCTAssertNotNil(model.serviceOperations[rotationRow])

    store.consume(
      Data((try frame("protocol-error", [
        "protocolVersion": 2,
        "code": "COMMAND_FAILED",
        "message": "pool storage is unavailable in this composition",
        "requestId": requestID,
      ]) + "\n").utf8)
    )
    // The engine's answer must reach the row without waiting for a snapshot:
    // that wait is the bug this pins.
    await waitUntil(model.serviceOperations[rotationRow] == nil)

    XCTAssertNil(model.serviceOperations[rotationRow])
    XCTAssertEqual(
      model.serviceFailures[rotationRow], "pool storage is unavailable in this composition")
    XCTAssertFalse(model.hubSourceShowsEnabled("hub/default/rotation"))
  }

  /// An unnamed rejection still releases the mutation slot; it simply cannot
  /// name the row, so the message is all the user gets.
  @MainActor
  func testUnnamedProtocolErrorStillReleasesTheSlot() throws {
    let (store, _, _) = makeProductionHarness()
    store.consume(Data((try frame("snapshot", makeHubSnapshotFrame()) + "\n").utf8))
    _ = store.mutate(
      operation: "hub-rotation", name: "default", enabled: true,
      activityLabel: "updating Proxy Hub rotation")
    XCTAssertNotNil(store.busyRequestId)

    store.consume(
      Data((try frame("protocol-error", [
        "protocolVersion": 2, "code": "MALFORMED_FRAME", "message": "command frame was rejected",
      ]) + "\n").utf8)
    )
    XCTAssertNil(store.busyRequestId)
    XCTAssertEqual(store.message, "command frame was rejected")
  }

  /// The diagnostic a protocol failure records must name the frame kind: a
  /// rejection nobody can attribute is a rejection nobody can fix.
  func testProtocolFailureDiagnosticNamesTheFrameKind() {
    XCTAssertEqual(
      AppServiceProtocolError.unexpectedFrame("snapshot-event").diagnosticDetail,
      "unexpectedFrame: snapshot-event")
    XCTAssertEqual(
      AppServiceProtocolError.invalidPayload("logs").diagnosticDetail, "invalidPayload: logs")
    XCTAssertEqual(AppServiceProtocolError.invalidUTF8.diagnosticDetail, "invalidUTF8")
    XCTAssertEqual(
      AppServiceProtocolError.decodeFailed(kind: "snapshot", detail: "keyNotFound(hub)")
        .diagnosticDetail,
      "snapshot: keyNotFound(hub)")
  }

  /// A hub snapshot with accounts of two providers that publish the same
  /// model: the compile turns that into a routing conflict with candidates.
  private func makeHubConflictSnapshotFrame() -> [String: Any] {
    var snapshot = makeHubSnapshotFrame()
    snapshot["hubSources"] = [
      [
        "id": "claude/a", "providerId": "claude", "name": "a", "label": "A",
        "detail": "", "enabled": true, "hub": "default",
      ],
      [
        "id": "codex/b", "providerId": "codex", "name": "b", "label": "B",
        "detail": "", "enabled": true, "hub": "default",
      ],
    ]
    snapshot["hubCatalogs"] = [
      ["accountID": "claude/a", "catalog": "claude", "models": ["sonnet-4"]],
      ["accountID": "codex/b", "catalog": "codex", "models": ["sonnet-4"]],
    ]
    snapshot["logSources"] = [
      ["id": "claude/a", "providerId": "claude", "name": "a", "label": "Claude proxy · A",
       "detail": "stopped"]
    ]
    return snapshot
  }

  /// A minimal hub snapshot carrying the rotation row the switch binds to.
  private func makeHubSnapshotFrame() -> [String: Any] {
    [
      "revision": 1,
      "proxyCount": 0,
      "routes": [],
      "actions": [],
      "usage": [],
      "proxies": [],
      "accounts": [],
      "hubSources": [
        [
          "id": "hub/default/rotation", "providerId": "", "name": "rotation",
          "label": "Rotate across accounts", "detail": "Spread each model", "enabled": false,
          "hub": "default", "rotates": true, "accountCount": 3,
        ]
      ],
      "gateways": [],
      "accountProviders": [],
      "gatewayProviders": [],
      "settings": [
        "launchAtLogin": false, "quotaGuardEnabled": true, "showQuota": true,
        "startEnabledProxies": true,
      ],
      "activity": [],
    ]
  }

  @MainActor
  func testServiceProtocolFailureIsRedactedBeforeFeedback() {
    let (store, _, box) = makeProductionHarness()
    let opaquePayload = String(repeating: "B", count: 512)
    store.updateServiceState(
      .degraded("The AnyPick service sent an unexpected \(opaquePayload) frame.")
    )

    XCTAssertNil(store.invoke(actionId: "route-1", label: "DeepSeek Harness · Work"))
    XCTAssertEqual(
      store.message,
      "AnyPick service is unavailable. Reopen AnyPick and try again."
    )
    XCTAssertFalse(store.message?.contains(opaquePayload) == true)
    XCTAssertTrue(box.lines.isEmpty)
  }

  @MainActor
  func testRouteResultSettlesWhenItArrivesBeforeBusySynchronization() async throws {
    let (store, model, _) = makeProductionHarness()
    store.consume(Data((try routeSnapshotFrame() + "\n").utf8))
    await waitUntil(model.apps.contains { $0.id == "dsh" })

    XCTAssertTrue(model.setRoute(appID: "dsh", routeID: "route-dsh-target"))
    guard let requestID = store.busyRequestId else {
      return XCTFail("route action did not claim the mutation slot")
    }

    // Deliver the terminal result before the observer task can process the
    // busy transition. The sheet must settle by request identity, not by a
    // potentially missed busy edge.
    let result = try frame("result", [
      "version": 1,
      "requestId": requestID,
      "status": "success",
    ])
    store.consume(Data((result + "\n").utf8))
    await waitUntil({
      if case .success(let appID, _) = model.switchPhase { return appID == "dsh" }
      return false
    }())

    if case .success(let appID, _) = model.switchPhase {
      XCTAssertEqual(appID, "dsh")
    } else {
      XCTFail("route result left the connection flow in \(model.switchPhase)")
    }
  }

  // MARK: - Confirmed forget (B3)

  @MainActor
  func testForgetBackupFailureKeepsPreviewAndShowsError() async throws {
    let (store, model, _) = makeProductionHarness()
    try await stageBackupPreview(store)
    await waitUntil(model.backups.contains { $0.id == "insp-1" })
    XCTAssertTrue(model.backups.contains { $0.id == "insp-1" })
    // Forget travels async: the row stays until the engine confirms.
    XCTAssertTrue(model.deleteBackup(id: "insp-1"))
    XCTAssertEqual(store.backupPreview?.inspectionId, "insp-1")
    XCTAssertTrue(model.backups.contains { $0.id == "insp-1" })
    guard let forgetID = store.busyRequestId else {
      return XCTFail("forget claimed no busy slot")
    }
    store.consume(
      Data(
        (try frame(
          "result",
          ["version": 1, "requestId": forgetID, "status": "error", "message": "forget failed"]
        ) + "\n").utf8))
    await waitUntil(model.feedback?.message == "forget failed")
    XCTAssertEqual(store.backupPreview?.inspectionId, "insp-1")
    XCTAssertTrue(model.backups.contains { $0.id == "insp-1" })
    XCTAssertEqual(model.feedback?.message, "forget failed")
  }

  @MainActor
  func testForgetBackupSuccessClearsPreview() async throws {
    let (store, model, _) = makeProductionHarness()
    try await stageBackupPreview(store)
    await waitUntil(model.backups.contains { $0.id == "insp-1" })
    XCTAssertTrue(model.deleteBackup(id: "insp-1"))
    guard let forgetID = store.busyRequestId else {
      return XCTFail("forget claimed no busy slot")
    }
    store.consume(
      Data(
        (try frame(
          "result",
          ["version": 1, "requestId": forgetID, "status": "success", "message": "Forgot review."]
        ) + "\n").utf8))
    await waitUntil(store.backupPreview == nil)
    XCTAssertNil(store.backupPreview)
    await waitUntil(!model.backups.contains { $0.id == "insp-1" })
    XCTAssertFalse(model.backups.contains { $0.id == "insp-1" })
  }

  @MainActor
  func testForgetBackupRefusedWhileBusyKeepsPreview() async throws {
    let (store, model, _) = makeProductionHarness()
    try await stageBackupPreview(store)
    await waitUntil(model.backups.contains { $0.id == "insp-1" })
    XCTAssertNotNil(
      store.mutate(
        operation: "account-refresh", name: "Work", providerId: "claude",
        activityLabel: "refreshing Work"))
    XCTAssertFalse(model.deleteBackup(id: "insp-1"))
    XCTAssertEqual(store.backupPreview?.inspectionId, "insp-1")
    XCTAssertTrue(model.backups.contains { $0.id == "insp-1" })
  }

  /// The menu switch shows the process, and the published toggle starts a
  /// stopped proxy. Asking to turn a stopped proxy off must not send it.
  @MainActor
  func testTurningOffAStoppedProxyDoesNotStartIt() async throws {
    let (store, model, box) = makeProductionHarness()
    store.consume(Data((try stoppedEnabledProxyFrame() + "\n").utf8))
    await waitUntil(store.proxies.contains { $0.id == "claude/work" })
    let proxy = try XCTUnwrap(store.proxies.first { $0.id == "claude/work" })
    XCTAssertFalse(proxy.running)
    XCTAssertTrue(proxy.enabled)

    let before = box.lines.count
    model.setProxyEnabled(id: "claude/work", enabled: false)
    XCTAssertEqual(box.lines.count, before)
    XCTAssertNil(store.busyRequestId)

    model.setProxyEnabled(id: "claude/work", enabled: true)
    let invokes = box.lines.filter { $0.hasPrefix("invoke\t") }
    XCTAssertEqual(invokes.count, 1)
    let payload = Data(base64Encoded: String(invokes[0].dropFirst("invoke\t".count)))
    let object = try JSONSerialization.jsonObject(with: try XCTUnwrap(payload)) as? [String: Any]
    XCTAssertEqual(object?["actionId"] as? String, "toggle-work")
  }

  /// A reviewed import says replace or new. The dialog must follow that,
  /// including when the backup label was renamed or collides with a saved name.
  @MainActor
  func testReviewedImportFollowsEngineDispositionNotTheLabel() async throws {
    let (store, model, _) = makeProductionHarness()
    store.consume(Data((try accountSnapshotFrame() + "\n").utf8))
    await waitUntil(model.accounts.contains { $0.name == "Work" && $0.provider == "Claude" })
    guard let inspectID = store.inspectBackup(path: "/tmp/review.anypick-backup") else {
      return XCTFail("inspect claimed no preview slot")
    }
    store.consume(
      Data(
        (try frame(
          "backup-preview",
          [
            "version": 1,
            "requestId": inspectID,
            "status": "ready",
            "inspectionId": "insp-rename",
            "createdAt": "Sep 6",
            "entries": [
              [
                "id": "renamed",
                "providerId": "claude",
                "name": "work",
                "label": "Old Work",
                "disposition": "replace",
              ],
              [
                "id": "collision",
                "providerId": "claude",
                "name": "other",
                "label": "Work",
                "disposition": "new",
              ],
            ],
          ]
        ) + "\n").utf8))
    await waitUntil(model.backups.contains { $0.id == "insp-rename" })
    let rows = try XCTUnwrap(model.backups.first { $0.id == "insp-rename" }?.accounts)
    let renamed = try XCTUnwrap(rows.first { $0.id == "renamed" })
    let collision = try XCTUnwrap(rows.first { $0.id == "collision" })
    XCTAssertEqual(renamed.name, "Old Work")
    XCTAssertTrue(model.alreadySavedAccount(renamed))
    XCTAssertEqual(collision.name, "Work")
    XCTAssertFalse(model.alreadySavedAccount(collision))
  }

  /// Fixture rows have no review disposition. They still match the saved
  /// provider and name the restore sheet already used.
  @MainActor
  func testSavedAccountMatchWithoutAReviewUsesProviderAndName() {
    let saved = DesignAccount(
      id: "claude/work", name: "Work", detail: "", provider: "Claude",
      symbol: "s", kind: .saved, status: .ready, lastUsed: "Saved", providerID: "claude")
    let model = MacOSDesignModel(
      destination: .accounts, phase: .ready, appearance: .system, activityShowsLogs: false,
      apps: [], accounts: [saved], proxies: [], activity: [], backups: [])
    let same = DesignAccount(
      id: "preview-same", name: "Work", detail: "", provider: "Claude",
      symbol: "s", kind: .saved, status: .ready, lastUsed: "")
    let other = DesignAccount(
      id: "preview-other", name: "Personal", detail: "", provider: "Claude",
      symbol: "s", kind: .saved, status: .ready, lastUsed: "")
    XCTAssertTrue(model.alreadySavedAccount(same))
    XCTAssertFalse(model.alreadySavedAccount(other))
  }

  /// Two rows can share a display name. The menu mark follows the route id
  /// the switch is actually on.
  @MainActor
  func testMenuSwitchMarkFollowsTheRouteBeingSwitched() {
    let work = DesignRoute(
      id: "r-work", name: "Work", detail: "", symbol: "person", kind: .account)
    let other = DesignRoute(
      id: "r-other", name: "Work", detail: "", symbol: "person", kind: .account)
    let app = DesignApp(
      id: "claude", name: "Claude", detail: "", symbol: "s", status: .ready,
      accountCount: 2, selectedRouteID: "r-current", routeOptions: [work, other],
      fastModel: "", reasoningModel: "", useCompatibleFallback: true)
    let model = MacOSDesignModel(
      destination: .accounts, phase: .ready, appearance: .system, activityShowsLogs: false,
      apps: [app], accounts: [], proxies: [], activity: [], backups: [])

    model.switchPhase = .inFlight(appID: "claude", from: "Current", to: "Work", routeID: "r-work")
    XCTAssertEqual(trayInlineSwitchState(model: model, app: app, route: work), .switching)
    XCTAssertEqual(trayInlineSwitchState(model: model, app: app, route: other), .available)

    model.switchPhase = .recovery(
      appID: "claude", requested: "Work", kept: "Current", routeID: "r-work")
    XCTAssertEqual(trayInlineSwitchState(model: model, app: app, route: work), .retry)
    XCTAssertEqual(trayInlineSwitchState(model: model, app: app, route: other), .available)
  }

  /// Go sends sourceId and does not send an upstream provider. Two saved
  /// logins with the same label stay two rows, and a second action for the
  /// same login collapses onto the selected id.
  @MainActor
  func testSameLabelRoutesStayDistinctWhenSourceIDsDiffer() async throws {
    let (store, model, _) = makeProductionHarness()
    store.consume(Data((try sameLabelRouteFrame() + "\n").utf8))
    await waitUntil(model.allSupportedApps.contains { $0.id == "claude" })
    let app = try XCTUnwrap(model.allSupportedApps.first { $0.id == "claude" })
    XCTAssertEqual(app.routeOptions.map(\.name), ["Work", "Work"])
    XCTAssertEqual(app.routeOptions.map(\.id), ["act-work-alt", "act-personal"])
    XCTAssertEqual(
      app.routeOptions.map(\.sourceID),
      ["account/claude/work", "account/claude/personal"])
  }

  /// The Models sheet's Refresh sends gateway-refresh. The engine names the
  /// gateway in sourceId and does not send an upstream provider, and the
  /// refresh command only needs the gateway name.
  @MainActor
  func testRefreshingAGatewayRouteSendsGatewayRefresh() async throws {
    let (store, model, box) = makeProductionHarness()
    store.consume(Data((try gatewayRouteFrame() + "\n").utf8))
    await waitUntil(model.allSupportedApps.contains { $0.id == "claude" })
    let app = try XCTUnwrap(model.allSupportedApps.first { $0.id == "claude" })
    XCTAssertEqual(app.selectedRouteID, "gw-or-work")
    model.apps = [app]

    model.refreshAppModels(appID: "claude")

    let payload = try XCTUnwrap(mutatePayload(in: box.lines))
    XCTAssertEqual(payload["operation"] as? String, "gateway-refresh")
    XCTAssertEqual(payload["name"] as? String, "or-work")
    XCTAssertNil(payload["providerId"])
    XCTAssertNotEqual(
      model.feedback?.message,
      "Refresh the selected account or gateway from Connections.")
  }

  /// A stopped proxy that a selected account route is using is attention,
  /// so Restart stays available. The provider is in sourceId. A proxy no
  /// selected route uses stays stopped.
  @MainActor
  func testAStoppedProxyAnAppIsUsingShowsAttention() async throws {
    let (store, model, _) = makeProductionHarness()
    store.consume(Data((try requiredProxyFrame() + "\n").utf8))
    await waitUntil(
      model.proxies.contains { $0.id == "claude/work" }
        && model.proxies.contains { $0.id == "codex/work" })
    XCTAssertEqual(model.proxies.first { $0.id == "claude/work" }?.status, .attention)
    XCTAssertEqual(model.proxies.first { $0.id == "codex/work" }?.status, .stopped)
  }

  /// A managed app stays in the list until client-reset succeeds. A refused
  /// reset, including one blocked by the single-flight slot, must not hide it.
  @MainActor
  func testRemovingAManagedAppWaitsUntilDisconnectSucceeds() async throws {
    useIsolatedAppPreferences()
    defer { restoreAppPreferences() }
    AppPreferences.addConfiguredApp("claude")
    let (store, model, box) = makeProductionHarness()
    store.consume(Data((try gatewayRouteFrame() + "\n").utf8))
    await waitUntil(model.apps.contains { $0.id == "claude" })
    let app = try XCTUnwrap(model.apps.first { $0.id == "claude" })
    XCTAssertTrue(isAppManagedByAnyPick(app))

    model.removeApp(appID: "claude")

    let payload = try XCTUnwrap(mutatePayload(in: box.lines))
    XCTAssertEqual(payload["operation"] as? String, "client-reset")
    XCTAssertEqual(payload["name"] as? String, "claude")
    XCTAssertFalse(AppPreferences.isAppRemoved("claude"))
    XCTAssertTrue(model.apps.contains { $0.id == "claude" })

    let requestID = try XCTUnwrap(payload["requestId"] as? String)
    store.consume(
      Data(
        (try frame(
          "result",
          [
            "version": 1, "requestId": requestID, "status": "success",
            "message": "Claude Code is using its official login.",
          ]) + "\n").utf8))
    await waitUntil(AppPreferences.isAppRemoved("claude"))
    XCTAssertFalse(model.apps.contains { $0.id == "claude" })
  }

  @MainActor
  func testRemovingAManagedAppKeepsItWhenDisconnectFails() async throws {
    useIsolatedAppPreferences()
    defer { restoreAppPreferences() }
    AppPreferences.addConfiguredApp("claude")
    let (store, model, box) = makeProductionHarness()
    store.consume(Data((try gatewayRouteFrame() + "\n").utf8))
    await waitUntil(model.apps.contains { $0.id == "claude" })

    model.removeApp(appID: "claude")
    let payload = try XCTUnwrap(mutatePayload(in: box.lines))
    let requestID = try XCTUnwrap(payload["requestId"] as? String)
    store.consume(
      Data(
        (try frame(
          "result",
          [
            "version": 1, "requestId": requestID, "status": "error",
            "message": "Could not restore the official login.",
          ]) + "\n").utf8))
    await waitUntil(model.feedback?.kind == .error)
    XCTAssertFalse(AppPreferences.isAppRemoved("claude"))
    XCTAssertTrue(model.apps.contains { $0.id == "claude" })
  }

  @MainActor
  func testRemovingAManagedAppWhileBusySendsNoReset() async throws {
    useIsolatedAppPreferences()
    defer { restoreAppPreferences() }
    AppPreferences.addConfiguredApp("claude")
    let (store, model, box) = makeProductionHarness()
    store.consume(Data((try gatewayRouteFrame() + "\n").utf8))
    await waitUntil(model.apps.contains { $0.id == "claude" })

    XCTAssertNotNil(
      store.mutate(
        operation: "account-refresh", name: "Work", providerId: "claude",
        activityLabel: "refreshing Work"))
    let sent = box.lines.count
    model.removeApp(appID: "claude")

    XCTAssertEqual(box.lines.count, sent)
    XCTAssertFalse(box.lines.contains { $0.contains("client-reset") })
    XCTAssertFalse(AppPreferences.isAppRemoved("claude"))
    XCTAssertTrue(model.apps.contains { $0.id == "claude" })
  }

  @MainActor
  func testRemovingAnUnmanagedAppDropsItWithoutAReset() async throws {
    useIsolatedAppPreferences()
    defer { restoreAppPreferences() }
    let (_, model, box) = makeProductionHarness()
    let app = DesignApp(
      id: "kiro", name: "Kiro", detail: "", symbol: "s", status: .ready,
      accountCount: 0, selectedRouteID: "native-kiro",
      routeOptions: [
        DesignRoute(
          id: "native-kiro", name: "Direct", detail: "", symbol: "s", kind: .native)
      ],
      fastModel: "", reasoningModel: "", useCompatibleFallback: false)
    model.allSupportedApps = [app]
    model.apps = [app]

    model.removeApp(appID: "kiro")

    XCTAssertTrue(box.lines.isEmpty)
    XCTAssertTrue(AppPreferences.isAppRemoved("kiro"))
    XCTAssertFalse(model.apps.contains { $0.id == "kiro" })
  }

  /// Creating the missing profiles is a button the user pressed. A refusal
  /// and an engine error both have to reach the alert.
  @MainActor
  func testCreatingCodexProfilesReportsARefusalAndAnEngineError() async throws {
    useIsolatedAppPreferences()
    defer { restoreAppPreferences() }
    AppPreferences.codexAutoProfilesEnabled = false
    let (store, model, box) = makeProductionHarness()
    store.consume(Data((try codexAccountSourceFrame() + "\n").utf8))
    await waitUntil(store.codexProfileSources.contains { $0.sourceId == "account/codex/work" })

    XCTAssertNotNil(
      store.mutate(
        operation: "account-refresh", name: "Work", providerId: "claude",
        activityLabel: "refreshing Work"))
    let refresh = try XCTUnwrap(mutatePayload(in: box.lines))
    XCTAssertFalse(model.createMissingCodexProfiles(sourceIDs: ["account/codex/work"]))
    XCTAssertEqual(model.feedback?.kind, .error)
    XCTAssertEqual(syncCommandCount(in: box.lines), 0)

    let refreshID = try XCTUnwrap(refresh["requestId"] as? String)
    store.consume(
      Data(
        (try frame(
          "result",
          [
            "version": 1, "requestId": refreshID, "status": "success",
            "message": "Refreshed.",
          ]) + "\n").utf8))
    await waitUntil(store.busyRequestId == nil)
    model.dismissFeedback()

    XCTAssertTrue(model.createMissingCodexProfiles(sourceIDs: ["account/codex/work"]))
    let payload = try XCTUnwrap(mutatePayload(in: box.lines, operation: "codex-profile-sync"))
    XCTAssertEqual(payload["operation"] as? String, "codex-profile-sync")
    let requestID = try XCTUnwrap(payload["requestId"] as? String)
    store.consume(
      Data(
        (try frame(
          "result",
          [
            "version": 1, "requestId": requestID, "status": "error",
            "message": "Could not create the Codex profile.",
          ]) + "\n").utf8))
    await waitUntil(model.feedback?.kind == .error)
    XCTAssertEqual(model.feedback?.message, "Could not create the Codex profile.")
  }

  /// A profile created on its own stays quiet when it works, and says so when
  /// the engine refuses. The refusal is remembered, so it is not sent again.
  @MainActor
  func testAutomaticCodexProfileSyncStaysQuietOnSuccessAndReportsFailure() async throws {
    useIsolatedAppPreferences()
    defer { restoreAppPreferences() }
    let (store, model, box) = makeProductionHarness()
    store.consume(Data((try codexAccountSourceFrame() + "\n").utf8))
    await waitUntil(syncCommandCount(in: box.lines) == 1)
    let payload = try XCTUnwrap(mutatePayload(in: box.lines, operation: "codex-profile-sync"))
    let requestID = try XCTUnwrap(payload["requestId"] as? String)
    store.consume(
      Data(
        (try frame(
          "result",
          [
            "version": 1, "requestId": requestID, "status": "success",
            "message": "Created 1 Codex profile.",
          ]) + "\n").utf8))
    await waitUntil(
      AppPreferences.codexAutoProfileSourceFingerprints.contains(
        AppPreferences.codexAutoProfileFingerprint(for: "account/codex/work")))
    XCTAssertNil(model.feedback)
    XCTAssertEqual(syncCommandCount(in: box.lines), 1)

    AppPreferences.codexAutoProfileSourceFingerprints = []
    let (failedStore, failedModel, failedBox) = makeProductionHarness()
    failedStore.consume(Data((try codexAccountSourceFrame() + "\n").utf8))
    await waitUntil(syncCommandCount(in: failedBox.lines) == 1)
    let failedPayload = try XCTUnwrap(mutatePayload(in: failedBox.lines, operation: "codex-profile-sync"))
    let failedID = try XCTUnwrap(failedPayload["requestId"] as? String)
    failedStore.consume(
      Data(
        (try frame(
          "result",
          [
            "version": 1, "requestId": failedID, "status": "error",
            "message": "Could not create the Codex profile.",
          ]) + "\n").utf8))
    await waitUntil(failedModel.feedback?.kind == .error)
    XCTAssertEqual(failedModel.feedback?.message, "Could not create the Codex profile.")
    let sent = syncCommandCount(in: failedBox.lines)
    failedStore.consume(Data((try codexAccountSourceFrame() + "\n").utf8))
    try await Task.sleep(nanoseconds: 50_000_000)
    XCTAssertEqual(syncCommandCount(in: failedBox.lines), sent)
  }

  @MainActor
  func testAutomaticCodexProfileSyncWaitsForAnAccountModelCatalog() async throws {
    useIsolatedAppPreferences()
    defer { restoreAppPreferences() }
    let (store, model, box) = makeProductionHarness()
    store.consume(
      Data((try codexAccountSourceFrame(
        sourceID: "account/zai/work", models: [], revision: 1
      ) + "\n").utf8))
    await waitUntil(store.codexProfileSources.contains { $0.sourceId == "account/zai/work" })
    XCTAssertEqual(syncCommandCount(in: box.lines), 0)

    store.consume(
      Data((try codexAccountSourceFrame(
        sourceID: "account/zai/work", models: ["glm-5"], revision: 2
      ) + "\n").utf8))
    await waitUntil(store.codexProfileSources.first?.models == ["glm-5"])
    await waitUntil(model.codexProfileSources.first?.models == ["glm-5"])
    XCTAssertTrue(AppPreferences.codexAutoProfilesEnabled)
    await waitUntil(syncCommandCount(in: box.lines) == 1)
    await waitUntil(model.isBusy)
    XCTAssertTrue(model.isBusy)
    let payload = try XCTUnwrap(mutatePayload(in: box.lines, operation: "codex-profile-sync"))
    let requestID = try XCTUnwrap(payload["requestId"] as? String)
    store.consume(
      Data(
        (try frame(
          "result",
          [
            "version": 1, "requestId": requestID, "status": "success",
            "message": "Created 1 Codex profile.",
          ]) + "\n").utf8))
    await waitUntil(store.busyRequestId == nil)
  }

  @MainActor
  func testBackupSelectionMatchesTheFileLimit() {
    func accounts(_ count: Int) -> [DesignAccount] {
      (0..<count).map { index in
        DesignAccount(
          id: "codex/a\(index)", name: "a\(index)", detail: "", provider: "Codex",
          symbol: "s", kind: .saved, status: .ready, lastUsed: "")
      }
    }
    let over = MacOSDesignModel(
      destination: .backups, phase: .ready, appearance: .system, activityShowsLogs: false,
      apps: [], accounts: accounts(BackupLimits.maxAccounts + 1), proxies: [], activity: [],
      backups: [])
    XCTAssertFalse(over.createBackup(accountIDs: Set(over.accounts.map(\.id))))
    XCTAssertEqual(over.feedback?.kind, .error)
    XCTAssertTrue(over.backups.isEmpty)
    XCTAssertEqual(
      over.feedback?.message,
      "Select between 1 and \(BackupLimits.maxAccounts) saved accounts.")

    let fit = MacOSDesignModel(
      destination: .backups, phase: .ready, appearance: .system, activityShowsLogs: false,
      apps: [], accounts: accounts(BackupLimits.maxAccounts), proxies: [], activity: [],
      backups: [])
    XCTAssertTrue(fit.createBackup(accountIDs: Set(fit.accounts.map(\.id))))
    XCTAssertEqual(fit.backups.first?.accountCount, BackupLimits.maxAccounts)
  }

  private var preferenceSuiteName: String?

  private func useIsolatedAppPreferences() {
    let name = "dev.anypick.tests.\(UUID().uuidString)"
    preferenceSuiteName = name
    let suite = UserDefaults(suiteName: name)!
    suite.removePersistentDomain(forName: name)
    AppPreferences.defaults = suite
  }

  private func restoreAppPreferences() {
    if let name = preferenceSuiteName {
      UserDefaults(suiteName: name)?.removePersistentDomain(forName: name)
      preferenceSuiteName = nil
    }
    AppPreferences.defaults = .standard
  }

  @MainActor
  private func makeProductionHarness() -> (TrayStore, ProductionDesignModel, CommandBox) {
    let box = CommandBox()
    let store = TrayStore(initialCount: 0)
    store.attachCommandSink { box.lines.append($0) }
    return (store, ProductionDesignModel(store: store), box)
  }

  private func mutatePayload(in lines: [String], operation: String? = nil) throws -> [String: Any] {
    for line in lines where line.hasPrefix("mutate\t") {
      let data = try XCTUnwrap(Data(base64Encoded: String(line.dropFirst("mutate\t".count))))
      let payload = try XCTUnwrap(JSONSerialization.jsonObject(with: data) as? [String: Any])
      if operation == nil || payload["operation"] as? String == operation {
        return payload
      }
    }
    XCTFail("no mutate command\(operation.map { " for \($0)" } ?? "")")
    return [:]
  }

  private func syncCommandCount(in lines: [String]) -> Int {
    lines.filter { line in
      guard line.hasPrefix("mutate\t"),
        let data = Data(base64Encoded: String(line.dropFirst("mutate\t".count))),
        let payload = try? JSONSerialization.jsonObject(with: data) as? [String: Any]
      else { return false }
      return payload["operation"] as? String == "codex-profile-sync"
    }.count
  }

  private func codexAccountSourceFrame(
    sourceID: String = "account/codex/work",
    models: [String] = ["gpt-5"],
    revision: Int = 1
  ) throws -> String {
    try frame("snapshot", [
      "revision": revision,
      "proxyCount": 0,
      "routes": [],
      "actions": [],
      "usage": [],
      "proxies": [],
      "accounts": [],
      "codexProfileSources": [[
        "sourceId": sourceID,
        "kind": "account",
        "label": "Work",
        "detail": "",
        "selected": true,
        "models": models,
      ]],
      "codexProfiles": [],
      "gateways": [],
      "accountProviders": [],
      "gatewayProviders": [],
      "settings": [
        "launchAtLogin": false,
        "startEnabledProxies": true,
        "showQuota": true,
        "quotaGuardEnabled": false,
      ],
      "activity": [],
    ])
  }

  private func gatewayRouteFrame() throws -> String {
    try frame("snapshot", [
      "revision": 1,
      "proxyCount": 0,
      "routes": [],
      "actions": [[
        "id": "gw-or-work",
        "clientId": "claude",
        "sourceId": "gateway/or-work",
        "client": "Claude",
        "label": "or-work",
        "kind": "gateway",
        "presentation": "app-route",
        "selected": true,
        "enabled": true,
        "routeKind": "gateway",
      ]],
      "usage": [],
      "proxies": [],
      "accounts": [],
      "gateways": [],
      "accountProviders": [],
      "gatewayProviders": [],
      "settings": [
        "launchAtLogin": false,
        "startEnabledProxies": true,
        "showQuota": true,
        "quotaGuardEnabled": false,
      ],
      "activity": [],
    ])
  }

  private func requiredProxyFrame() throws -> String {
    try frame("snapshot", [
      "revision": 1,
      "proxyCount": 2,
      "routes": [],
      "actions": [[
        "id": "route-claude-work",
        "clientId": "codex",
        "sourceId": "account/claude/work",
        "client": "Codex",
        "label": "Claude · Work",
        "kind": "native",
        "presentation": "app-route",
        "selected": true,
        "enabled": true,
        "routeKind": "managed-account",
      ]],
      "usage": [],
      "proxies": [
        [
          "id": "claude/work",
          "providerId": "claude",
          "label": "Claude · Work",
          "detail": "stopped",
          "running": false,
          "enabled": true,
          "toggleActionId": "toggle-claude",
          "restartActionId": "restart-claude",
        ],
        [
          "id": "codex/work",
          "providerId": "codex",
          "label": "Codex · Work",
          "detail": "stopped",
          "running": false,
          "enabled": true,
          "toggleActionId": "toggle-codex",
          "restartActionId": "restart-codex",
        ],
      ],
      "accounts": [],
      "gateways": [],
      "accountProviders": [],
      "gatewayProviders": [],
      "settings": [
        "launchAtLogin": false,
        "startEnabledProxies": true,
        "showQuota": true,
        "quotaGuardEnabled": false,
      ],
      "activity": [],
    ])
  }

  private func stoppedEnabledProxyFrame() throws -> String {
    try frame("snapshot", [
      "revision": 1,
      "proxyCount": 1,
      "routes": [],
      "actions": [],
      "usage": [],
      "proxies": [[
        "id": "claude/work",
        "providerId": "claude",
        "label": "Claude · Work",
        "detail": "127.0.0.1:8317",
        "running": false,
        "enabled": true,
        "toggleActionId": "toggle-work",
        "restartActionId": "restart-work",
      ]],
      "accounts": [],
      "gateways": [],
      "accountProviders": [],
      "gatewayProviders": [],
      "settings": [
        "launchAtLogin": false,
        "startEnabledProxies": true,
        "showQuota": true,
        "quotaGuardEnabled": false,
      ],
      "activity": [],
    ])
  }

  private func sameLabelRouteFrame() throws -> String {
    try frame("snapshot", [
      "revision": 1,
      "proxyCount": 0,
      "routes": [],
      "actions": [
        [
          "id": "act-work",
          "clientId": "claude",
          "sourceId": "account/claude/work",
          "client": "Claude",
          "label": "Work",
          "kind": "account",
          "presentation": "app-route",
          "selected": false,
          "enabled": true,
          "routeKind": "account",
        ],
        [
          "id": "act-personal",
          "clientId": "claude",
          "sourceId": "account/claude/personal",
          "client": "Claude",
          "label": "Work",
          "kind": "account",
          "presentation": "app-route",
          "selected": false,
          "enabled": true,
          "routeKind": "account",
        ],
        [
          "id": "act-work-alt",
          "clientId": "claude",
          "sourceId": "account/claude/work",
          "client": "Claude",
          "label": "Work",
          "kind": "account",
          "presentation": "app-route",
          "selected": true,
          "enabled": true,
          "routeKind": "account",
        ],
      ],
      "usage": [],
      "proxies": [],
      "accounts": [],
      "gateways": [],
      "accountProviders": [],
      "gatewayProviders": [],
      "settings": [
        "launchAtLogin": false,
        "startEnabledProxies": true,
        "showQuota": true,
        "quotaGuardEnabled": false,
      ],
      "activity": [],
    ])
  }

  private func accountSnapshotFrame() throws -> String {
    try frame("snapshot", [
      "revision": 1,
      "proxyCount": 0,
      "routes": [],
      "actions": [],
      "usage": [],
      "proxies": [],
      "accounts": [[
        "id": "acc-1",
        "providerId": "claude",
        "name": "Work",
        "label": "Work",
        "detail": "Claude · Work",
        "active": false,
        "canRefresh": true,
        "switchActionId": "switch-1",
      ]],
      "gateways": [],
      "accountProviders": [[
        "id": "claude",
        "providerId": "claude",
        "clientId": "claude",
        "sourceId": "claude",
        "label": "Claude Code",
        "detail": "Local Claude Code login",
        "installed": true,
        "livePresent": true,
        "liveIdentity": "claude@example.com",
        "loginMethods": [],
        "canClear": true,
        "credentialKinds": [],
      ]],
      "gatewayProviders": [],
      "settings": [
        "launchAtLogin": false,
        "startEnabledProxies": true,
        "showQuota": true,
        "quotaGuardEnabled": false,
      ],
      "activity": [],
    ])
  }

  private func geminiLoginSnapshotFrame() throws -> String {
    try frame("snapshot", [
      "revision": 1,
      "proxyCount": 0,
      "routes": [],
      "actions": [],
      "usage": [],
      "proxies": [],
      "accounts": [],
      "gateways": [],
      "accountProviders": [[
        "id": "gemini",
        "providerId": "gemini",
        "clientId": "gemini",
        "sourceId": "gemini-cli",
        "label": "Google Gemini",
        "detail": "Google subscription or API key",
        "installed": true,
        "livePresent": false,
        "loginMethods": [[
          "id": "gemini-subscription",
          "label": "Gemini subscription",
          "detail": "Google browser sign-in for Gemini CLI",
          "provenance": "official",
          "preferred": true,
          "available": true,
          "sourceId": "gemini-cli",
        ], [
          "id": "antigravity-subscription",
          "label": "Antigravity subscription",
          "detail": "Google browser sign-in for Antigravity-compatible access",
          "provenance": "official",
          "preferred": false,
          "available": true,
          "sourceId": "antigravity",
        ]],
        "canClear": false,
        "credentialKinds": [],
      ]],
      "gatewayProviders": [],
      "settings": [
        "launchAtLogin": false,
        "startEnabledProxies": true,
        "showQuota": true,
        "quotaGuardEnabled": false,
      ],
      "activity": [],
    ])
  }

  private func routeSnapshotFrame() throws -> String {
    try frame("snapshot", [
      "revision": 1,
      "proxyCount": 0,
      "routes": [[
        "clientId": "dsh",
        "client": "DeepSeek Harness",
        "source": "account/workbuddy/work",
        "status": "ready",
      ]],
      "actions": [[
        "id": "route-dsh-current",
        "clientId": "dsh",
        "sourceId": "account/workbuddy/work",
        "client": "DeepSeek Harness",
        "label": "WorkBuddy · work",
        "kind": "account",
        "presentation": "app-route",
        "selected": true,
        "enabled": true,
        "routeKind": "account",
        "upstreamProviderId": "workbuddy",
        "upstreamSourceLabel": "work",
      ], [
        "id": "route-dsh-target",
        "clientId": "dsh",
        "sourceId": "account/workbuddy/other",
        "client": "DeepSeek Harness",
        "label": "WorkBuddy · other",
        "kind": "account",
        "presentation": "app-route",
        "selected": false,
        "enabled": true,
        "routeKind": "account",
        "upstreamProviderId": "workbuddy",
        "upstreamSourceLabel": "other",
      ]],
      "usage": [],
      "proxies": [],
      "accounts": [],
      "gateways": [],
      "accountProviders": [],
      "gatewayProviders": [],
      "settings": [
        "launchAtLogin": false,
        "startEnabledProxies": true,
        "showQuota": true,
        "quotaGuardEnabled": false,
      ],
      "activity": [],
    ])
  }

  @MainActor
  private func stageBackupPreview(_ store: TrayStore) async throws {
    guard let inspectID = store.inspectBackup(path: "/tmp/review.anypick-backup") else {
      return XCTFail("inspect claimed no preview slot")
    }
    store.consume(
      Data(
        (try frame("backup-preview", [
          "version": 1,
          "requestId": inspectID,
          "status": "ready",
          "inspectionId": "insp-1",
          "createdAt": "Sep 6",
          "entries": [[
            "id": "e-1",
            "providerId": "claude",
            "name": "Work",
            "label": "Work",
            "disposition": "new",
          ]],
        ]) + "\n").utf8))
  }

  @MainActor
  private func waitUntil(_ condition: @autoclosure () -> Bool) async {
    for _ in 0..<200 {
      if condition() { return }
      try? await Task.sleep(nanoseconds: 5_000_000)
    }
  }
}

private final class CommandBox {
  var lines: [String] = []
}

final class FooterAlignmentTests: XCTestCase {
  func testScrollerReserveMatchesLegacyScrollBarGap() {
    XCTAssertEqual(designScrollerReserve(viewport: 480, content: 480), 0)
    XCTAssertEqual(designScrollerReserve(viewport: 480, content: 479.6), 0)
    // The reported Export Accounts sheet: 33px @2x ≈ 16pt of scroll bar.
    XCTAssertEqual(designScrollerReserve(viewport: 480, content: 463.5), 17)
    XCTAssertEqual(designScrollerReserve(viewport: 480, content: 464), 16)
    XCTAssertEqual(designScrollerReserve(viewport: 480, content: 300), 24, "capped")
    XCTAssertEqual(designScrollerReserve(viewport: 0, content: 464), 0)
  }

  @MainActor
  func testBackupStartupFlowsPickASheet() {
    let model = MacOSDesignModel.fromEnvironment(["ANYPICK_MACOS_FIXTURE": "ready"])
    XCTAssertFalse(model.backups.isEmpty, "fixture needs backups")
    let restore = backupStartupPresentation(flow: "restore-backup", backups: model.backups)
    XCTAssertEqual(restore, BackupPresentation(id: model.backups[0].id, importedPackage: false))
    let imported = backupStartupPresentation(flow: "import-backup", backups: model.backups)
    XCTAssertEqual(imported?.importedPackage, true)
    XCTAssertNil(backupStartupPresentation(flow: "create-backup", backups: model.backups))
    XCTAssertNil(backupStartupPresentation(flow: "import-backup", backups: []))
  }
}

final class FooterV5Tests: XCTestCase {
  @MainActor
  func testBackupStartupFlowsShareOneSheetSlot() {
    let model = MacOSDesignModel.fromEnvironment(["ANYPICK_MACOS_FIXTURE": "ready"])
    XCTAssertTrue(model.backups.contains { $0.id == "backup-import" }, "ready fixture needs the import backup")
    XCTAssertEqual(backupStartupSheet(flow: "create-backup", backups: model.backups), .create)
    XCTAssertEqual(
      backupStartupSheet(flow: "restore-backup", backups: model.backups),
      .review(BackupPresentation(id: model.backups[0].id, importedPackage: false)))
    XCTAssertEqual(
      backupStartupSheet(flow: "import-backup", backups: model.backups),
      .review(BackupPresentation(id: "backup-import", importedPackage: true)))
    XCTAssertNil(backupStartupSheet(flow: nil, backups: model.backups))
    // The flow reaches BackupsView: destination and pending flow are set.
    for flow in ["create-backup", "restore-backup", "import-backup"] {
      let m = MacOSDesignModel.fromEnvironment(["ANYPICK_MACOS_FIXTURE": "ready", "ANYPICK_MACOS_FLOW": flow])
      XCTAssertEqual(m.destination, .backups, flow)
      XCTAssertEqual(m.pendingStartupFlow, flow)
    }
  }

  func testSheetScrollCapFitsTheWindow() {
    XCTAssertEqual(designSheetMaxScrollHeight(windowHeight: 0), 560)
    XCTAssertEqual(designSheetMaxScrollHeight(windowHeight: 900), 560)
    XCTAssertEqual(designSheetMaxScrollHeight(windowHeight: 680), 460)
    XCTAssertEqual(designSheetMaxScrollHeight(windowHeight: 300), 160)
  }

  @MainActor
  func testBackupsAndAccountsStartupFlowsUseTheSameMechanism() {
    // Same delay constant, disjoint flow sets, and every Backups flow maps to
    // a sheet in the ready fixture exactly like the Accounts flows do.
    XCTAssertEqual(DesignStartupFlow.presentationDelay, 0.25)
    XCTAssertTrue(DesignStartupFlow.accountsFlows.isDisjoint(with: DesignStartupFlow.backupsFlows))
    XCTAssertTrue(DesignStartupFlow.accountsFlows.contains("add-account"))
    let model = MacOSDesignModel.fromEnvironment(["ANYPICK_MACOS_FIXTURE": "ready"])
    for flow in DesignStartupFlow.backupsFlows {
      XCTAssertNotNil(backupStartupSheet(flow: flow, backups: model.backups), flow)
    }
  }
}

final class UpdatesPaneTests: XCTestCase {
  func testHelperExitPreservesTerminalErrorsAndRejectsIncompleteResults() {
    for kind in ["offline", "rateLimited", "badChecksum", "hostBlocked", "notWritable", "storageUnavailable"] {
      let status = fixture(kind)
      XCTAssertEqual(UpdateCoreBridge.finalStatus(status, exitStatus: 1, current: "1.1.0"), status)
    }
    for kind in ["checking", "downloading", "verifying"] {
      for code: Int32 in [0, 1] {
        XCTAssertEqual(
          UpdateCoreBridge.finalStatus(fixture(kind), exitStatus: code, current: "1.1.0"),
          .bridgeFailure(current: "1.1.0"))
      }
    }
    for kind in ["upToDate", "availableDirect", "availablePackageManager", "ready"] {
      let status = fixture(kind)
      XCTAssertEqual(UpdateCoreBridge.finalStatus(status, exitStatus: 0, current: "1.1.0"), status)
      XCTAssertEqual(
        UpdateCoreBridge.finalStatus(status, exitStatus: 1, current: "1.1.0"),
        .bridgeFailure(current: "1.1.0"))
    }
    XCTAssertEqual(
      UpdateCoreBridge.finalStatus(nil, exitStatus: 0, current: "1.1.0"),
      .bridgeFailure(current: "1.1.0"))
  }

  private func fixture(_ kind: String) -> UpdateStatusDTO {
    guard let status = UpdateStatusFixtures.status(kind) else {
      XCTFail("missing fixture \(kind)")
      return .bridgeFailure(current: "1.1.0")
    }
    return status
  }

  func testEveryFixtureDecodes() {
    for kind in UpdateStatusFixtures.lines.keys {
      XCTAssertEqual(UpdateStatusFixtures.status(kind)?.kind, kind)
    }
    XCTAssertEqual(UpdateStatusFixtures.lines.count, 13)
  }

  func testDirectInstallShowsDownloadUpdateAndChangelog() {
    let p = UpdatePanePresentation(fixture("availableDirect"))
    XCTAssertTrue(p.showsDownloadUpdate)
    XCTAssertTrue(p.showsChangelog)
    XCTAssertFalse(p.showsCommand)
  }

  func testPackageManagerShowsCommandNotUpdateNow() {
    let status = fixture("availablePackageManager")
    let p = UpdatePanePresentation(status)
    XCTAssertFalse(p.showsDownloadUpdate)
    XCTAssertTrue(p.showsCommand)
    XCTAssertEqual(status.command, "brew upgrade --cask anypick")
  }

  func testHostBlockedHasViewOnGitHubAndNoRetry() {
    let status = fixture("hostBlocked")
    let p = UpdatePanePresentation(status)
    XCTAssertTrue(p.showsViewOnGitHub)
    XCTAssertFalse(p.showsRetry)
    XCTAssertFalse(p.showsDownloadUpdate)
    XCTAssertTrue(status.message?.hasPrefix(
      "Update didn't finish. The download came from an address AnyPick doesn't trust") ?? false)
  }

  func testOfflineAndBadChecksumOfferRetry() {
    XCTAssertTrue(UpdatePanePresentation(fixture("offline")).showsRetry)
    XCTAssertTrue(UpdatePanePresentation(fixture("badChecksum")).showsRetry)
  }

  func testStorageUnavailableShowsErrorWithGitHubAndRetryActions() {
    let status = fixture("storageUnavailable")
    let presentation = UpdatePanePresentation(status)
    XCTAssertTrue(presentation.isError)
    XCTAssertTrue(presentation.showsViewOnGitHub)
    XCTAssertTrue(presentation.showsRetry)
    XCTAssertFalse(presentation.showsDownloadUpdate)
    XCTAssertEqual(status.message,
      "AnyPick couldn't read or save the update safety state. No update was downloaded. Check folder permissions, then retry.")
  }

  func testProgressStates() {
    let downloading = UpdatePanePresentation(fixture("downloading"))
    XCTAssertTrue(downloading.showsProgress)
    XCTAssertFalse(downloading.isIndeterminate)
    XCTAssertTrue(UpdatePanePresentation(fixture("checking")).isIndeterminate)
    XCTAssertTrue(UpdatePanePresentation(fixture("verifying")).isIndeterminate)
  }

  func testReadyHasFootnoteAndNoVerifiedWord() {
    let status = fixture("ready")
    XCTAssertNotNil(status.footnote)
    XCTAssertFalse(status.message?.lowercased().contains("verified") ?? true)
    XCTAssertTrue(UpdatePanePresentation(status).showsRevealDownload)
  }

  func testRejectsUnknownSchema() {
    XCTAssertNil(UpdateStatusDTO.decode(line: #"{"schema":2,"kind":"upToDate","current":"1","channel":"direct","progress":0,"retry":false}"#))
    XCTAssertNil(UpdateStatusDTO.decode(line: "not json"))
  }

  func testReleaseNotesRenderHeadingsAndListsNotRawMarkdown() {
    let notes = fixture("availableDirect").notes ?? ""
    let blocks = ReleaseNotesMarkdown.blocks(notes)
    XCTAssertEqual(blocks.first, .heading(level: 2, text: "What's new"))
    XCTAssertTrue(blocks.contains(.bullet(text: "Settings > Updates checks GitHub Releases for you.")))
    for block in blocks {
      switch block {
      case .heading(_, let text), .bullet(let text), .paragraph(let text):
        XCTAssertFalse(text.hasPrefix("#"), "raw heading marker leaked: \(text)")
        XCTAssertFalse(text.hasPrefix("- "), "raw list marker leaked: \(text)")
      }
    }
  }

  func testReleaseNotesBlocksParagraphsAndComments() {
    let blocks = ReleaseNotesMarkdown.blocks(
      "Intro line one\nline two\n\n<!-- anypick-release-scope=all -->\n### Fixed\n* **Bold** item\n#hashtag")
    XCTAssertEqual(blocks, [
      .paragraph(text: "Intro line one line two"),
      .heading(level: 3, text: "Fixed"),
      .bullet(text: "**Bold** item"),
      .paragraph(text: "#hashtag"),
    ])
  }

  func testReleaseNotesInlineMarkdownAndFallback() {
    XCTAssertEqual(String(ReleaseNotesMarkdown.inline("**Bold** `code`").characters), "Bold code")
    // Unparseable or odd input still shows its text instead of nothing.
    let odd = "[unclosed link(https://x"
    XCTAssertFalse(String(ReleaseNotesMarkdown.inline(odd).characters).isEmpty)
    XCTAssertTrue(ReleaseNotesMarkdown.blocks("").isEmpty)
  }

  @MainActor
  func testReleaseNotesViewRendersRealReleaseBody() {
    let body = "## What's Changed\n* feat: x by @outof0 in https://github.com/outof0/anypick/pull/1\n\n<!-- c -->\n\n### Added\n- Linux\n  installers"
    let host = NSHostingView(rootView: ReleaseNotesView(notes: body).frame(width: 600))
    host.layoutSubtreeIfNeeded()
    XCTAssertGreaterThan(host.fittingSize.height, 0)
  }

  @MainActor
  func testPaneRendersEveryFixture() {
    let preferences = MacOSDesignModel(
      destination: .settings, phase: .ready, appearance: .system, activityShowsLogs: false,
      apps: [], accounts: [], proxies: [], activity: [], backups: [])
    for kind in UpdateStatusFixtures.lines.keys {
      let model = UpdatesModel(environment: ["ANYPICK_MACOS_UPDATE_FIXTURE": kind])
      let host = NSHostingView(
        rootView: Form { SettingsUpdatesPane(updates: model, model: preferences) }.formStyle(.grouped))
      host.frame = NSRect(x: 0, y: 0, width: 720, height: 640)
      host.layoutSubtreeIfNeeded()
    }
  }
}
