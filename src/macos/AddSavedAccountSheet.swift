import SwiftUI

struct AddSavedAccountSheet: View {
  private enum SourceMode: String, CaseIterable, Identifiable {
    case thisMac
    case newAccount
    case credential
    case paste
    var id: Self { self }
  }

  @ObservedObject var model: MacOSDesignModel
  @Environment(\.dismiss) private var dismiss
  @State private var provider = ""
  @State private var sourceMode: SourceMode =
    ProcessInfo.processInfo.environment["ANYPICK_MACOS_FLOW"] == "add-account-error" ? .newAccount : .thisMac
  @State private var accountName = ""
  @State private var detectedIdentity = ""
  @State private var detectedSource = ""
  @State private var localSourceID = ""
  @State private var loginMethod = ""
  @State private var confirmation: DesignConfirmation?
  @State private var isVerifying = false
  @State private var isDetecting = false
  @State private var credentialKind = ""
  @State private var credentialProfile = ""
  @State private var apiSecret = ""
  @State private var revealSecret = false
  @State private var authJSON = ""
  /// Set when the user types a name. A suggested name must not override the
  /// email inside a pasted auth file.
  @State private var nameTouched = false
  /// Kept across ACCOUNT_EXISTS so Replace sends the same file.
  @State private var stagedAuthPath: String?
  @State private var replaceExisting = false
  /// Cloudflare AI Gateway routes per account: the engine's profile for this
  /// provider is the free-form `<account_id>/<gateway_id>` pair, not a fixed
  /// endpoint preset, so the sheet collects it as typed input.
  @State private var cloudflareRouting = ""
  /// Production save waits for the engine result instead of dismissing
  /// on accept: failures keep field context instead of arriving after close.
  @State private var awaitingSaveResult = false
  @State private var saveError: String?
  @State private var detectionTask: Task<Void, Never>?
  @State private var loginTask: Task<Void, Never>?
  @FocusState private var nameFocused: Bool

  private var providers: [DesignProviderOption] { model.savedAccountProviderOptions }
  private var selectedProvider: DesignProviderOption? { providers.first { $0.id == provider } }
  private var providerLabel: String { selectedProvider?.label ?? provider }
  private var providerIconID: String { selectedProvider?.iconID ?? provider }
  private var loginMethods: [DesignLoginMethod] { selectedProvider?.loginMethods ?? [] }
  private var localLoginMethods: [DesignLoginMethod] {
    loginMethods.filter {
      guard let sourceID = $0.sourceID else { return false }
      return !sourceID.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty
    }
  }
  private var showsLocalSourcePicker: Bool {
    sourceMode == .thisMac && localLoginMethods.count > 1
  }
  private var selectedLoginMethod: DesignLoginMethod? {
    loginMethods.first { $0.id == loginMethod }
  }
  /// Tencent's WorkBuddy/CodeBuddy endpoints are undocumented — the method
  /// carries provenance "community", so say so instead of "official".
  private var isCommunityFlow: Bool { selectedLoginMethod?.provenance == "community" }
  private var isWorkBuddyProvider: Bool {
    ["workbuddy", "codebuddy"].contains(provider.lowercased())
  }
  /// The WorkBuddy desktop app shares its login through its session file,
  /// so "On This Mac" sees the app's current login alongside any previous
  /// AnyPick sign-in. When the app is present we say so explicitly instead
  /// of the flat "No login on this Mac".
  private var workBuddyAppInstalled: Bool {
    guard isWorkBuddyProvider else { return false }
    let home = FileManager.default.homeDirectoryForCurrentUser.path
    return [".workbuddy-ai", ".workbuddy", ".codebuddy"].contains {
      var isDir: ObjCBool = false
      return
        FileManager.default.fileExists(
          atPath: home + "/" + $0, isDirectory: &isDir) && isDir.boolValue
    }
  }
  private var isZaiProvider: Bool { provider.lowercased() == "zai" }
  private var isCloudflareProvider: Bool { provider.lowercased() == "cloudflare-aigateway" }
  /// Routing pair the engine parses as profile `<account_id>/<gateway_id>`.
  /// Empty here only disables submit; format errors stay engine-owned and
  /// surface through the save result.
  private var cloudflareRoutingTrimmed: String {
    cloudflareRouting.trimmingCharacters(in: .whitespacesAndNewlines)
  }
  /// The ZCode desktop app keeps its login in an encrypted Electron store.
  /// The provider owns the read-only decryption boundary; this view only uses
  /// the directory as a hint when explaining the available account paths.
  private var zcodeAppInstalled: Bool {
    guard isZaiProvider else { return false }
    let home = FileManager.default.homeDirectoryForCurrentUser.path
    let candidates = [
      home + "/.zcode",
      home + "/Library/Application Support/ZCode",
      "/Applications/ZCode.app",
    ]
    return candidates.contains {
      var isDirectory: ObjCBool = false
      return FileManager.default.fileExists(atPath: $0, isDirectory: &isDirectory)
        && isDirectory.boolValue
    }
  }
  private var zcodePlanWarning: String? {
    guard zcodeAppInstalled else { return nil }
    let url = URL(
      fileURLWithPath: FileManager.default.homeDirectoryForCurrentUser.path
        + "/.zcode/v2/coding-plan-cache.json")
    guard let data = try? Data(contentsOf: url) else { return nil }
    return zcodeCodingPlanWarning(data)
  }
  private var supportsNewAccountLogin: Bool { !loginMethods.isEmpty }
  /// Typed credential input for provider-declared API keys / plan keys.
  /// A native provider can expose both paths: when a live login is present,
  /// keep "On This Mac" available so adding Gemini does not unexpectedly
  /// replace the current-login flow with a key-only form.
  private var credentialKinds: [DesignCredentialKind] { selectedProvider?.credentialKinds ?? [] }
  private var availableSourceModes: [SourceMode] {
    var modes: [SourceMode] = [.thisMac]
    if supportsNewAccountLogin { modes.append(.newAccount) }
    if !credentialKinds.isEmpty { modes.append(.credential) }
    if selectedProvider?.acceptsAuthPaste == true { modes.append(.paste) }
    return modes
  }
  private var isKeyInputMode: Bool {
    sourceMode == .credential
  }
  private var selectedCredentialKind: DesignCredentialKind? {
    credentialKinds.first { $0.kind == credentialKind } ?? credentialKinds.first
  }
  private var availableProfiles: [DesignCredentialProfile] {
    selectedCredentialKind?.profiles ?? []
  }
  private var selectedProfileID: String {
    if availableProfiles.contains(where: { $0.id == credentialProfile }) { return credentialProfile }
    return availableProfiles.first?.id ?? ""
  }

  private var currentLogin: DesignLiveLogin? {
    liveLogin(for: selectedProvider)
  }

  /// A provider may expose a browser sign-in product and a different local
  /// store that can be imported without opening a browser. Keep the selected
  /// local store explicit so Gemini CLI and Antigravity cannot be conflated.
  private var selectedLocalLoginMethod: DesignLoginMethod? {
    guard sourceMode == .thisMac else { return nil }
    if let selected = localLoginMethods.first(where: {
      $0.sourceID?.caseInsensitiveCompare(localSourceID) == .orderedSame
    }) {
      return selected
    }
    return localLoginMethods.first
  }

  private var localLoginSourceName: String? {
    selectedLocalLoginMethod?.sourceLabel ?? selectedLocalLoginMethod?.label
  }

  private var hasIdentity: Bool {
    !detectedIdentity.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty
  }

  private var sourceAppName: String {
    if let localLoginSourceName {
      return localLoginSourceName
    }
    return currentLogin?.appName ?? selectedProvider?.label ?? anypickDisplayName(provider)
  }

  private var accountNameBinding: Binding<String> {
    Binding(
      get: { accountName },
      set: {
        accountName = $0
        nameTouched = true
      }
    )
  }

  private var canSubmit: Bool {
    let blocked = isVerifying || isDetecting
    if sourceMode == .paste {
      let body = authJSON.trimmingCharacters(in: .whitespacesAndNewlines)
      return !body.isEmpty && selectedProvider?.enabled == true && !blocked
    }
    if isKeyInputMode {
      if isCloudflareProvider, cloudflareRoutingTrimmed.isEmpty { return false }
      return addCredentialInputCanSubmit(
        name: accountName,
        secret: apiSecret,
        providerEnabled: selectedProvider?.enabled == true,
        isBlocked: blocked,
        secretOptional: selectedCredentialKind?.secretOptional == true
      )
    }
    if sourceMode == .newAccount, !hasIdentity {
      return addSavedAccountCanSubmit(
        name: accountName,
        isNewAccountMode: true,
        hasIdentity: false,
        hasLiveLogin: false,
        methodAvailable: selectedLoginMethod?.available == true,
        providerEnabled: selectedProvider?.enabled == true,
        isBlocked: blocked
      )
    }
    return addSavedAccountCanSubmit(
      name: accountName,
      isNewAccountMode: sourceMode == .newAccount,
      hasIdentity: hasIdentity,
      hasLiveLogin: currentLogin != nil,
      methodAvailable: selectedLoginMethod?.available == true,
      providerEnabled: selectedProvider?.enabled == true,
      isBlocked: blocked
    )
  }

/// Engine-provided: why the primary action is disabled, or nil when a provider
/// is usable.
  private var signInBlockerMessage: String? {
    addAccountBlockerMessage(
      provider: selectedProvider,
      method: selectedLoginMethod,
      isNewAccountMode: sourceMode == .newAccount,
      using: model
    )
  }

  private var primaryTitle: String {
    if isDetecting || isVerifying { return model.localized("desktop.common.checking") }
    if sourceMode == .paste, replaceExisting {
      let typed = accountName.trimmingCharacters(in: .whitespacesAndNewlines)
      return typed.isEmpty
        ? model.localized("desktop.add_account.replace_account")
        : model.localized("desktop.add_account.replace_named", replacing: ["name": typed])
    }
    if sourceMode == .newAccount, !hasIdentity {
      return model.localized("desktop.add_account.sign_in_with", replacing: ["provider": providerLabel])
    }
    return model.localized("desktop.accounts.add_login")
  }

  private var primaryHelp: String {
    if isDetecting || isVerifying { return model.localized("desktop.add_account.checking_help") }
    if sourceMode == .paste, replaceExisting { return model.localized("desktop.add_account.replace_auth_help") }
    if sourceMode == .paste { return model.localized("desktop.add_account.save_auth_help") }
    if isKeyInputMode { return model.localized("desktop.add_account.save_key_help") }
    return model.localized("desktop.add_account.save_login_help")
  }

  private func sourceModeTitle(_ mode: SourceMode) -> String {
    let key = switch mode {
    case .thisMac: "desktop.add_account.mode_this_mac"
    case .newAccount: "desktop.add_account.mode_new_account"
    case .credential: "desktop.add_account.mode_api_key"
    case .paste: "desktop.add_account.mode_paste_auth"
    }
    return model.localized(key)
  }

  private var autoDetectionKey: String {
    "\(sourceMode.rawValue):\(provider):\(localSourceID)"
  }

  var body: some View {
    DesignSheetHost(
      model: model,
      title: model.localized("desktop.accounts.add_login"),
      width: 440,
      primaryTitle: primaryTitle,
      primaryDisabled: !canSubmit || model.isBusy || awaitingSaveResult,
      primaryIdentifier: "account-flow.save",
      primaryHelp: primaryHelp,
      onCancel: cancelAndDismiss,
      onPrimary: submit
    ) {
      Form {
        Section {
          if availableSourceModes.count > 1 {
            Picker(model.localized("desktop.add_account.source"), selection: $sourceMode) {
              ForEach(availableSourceModes) { mode in
                Text(sourceModeTitle(mode)).tag(mode)
              }
            }
            .pickerStyle(.segmented)
            .labelsHidden()
            .help(model.localized("desktop.add_account.source_help"))
            .accessibilityIdentifier("account-flow.source")
          }

          LabeledContent(model.localized("desktop.account_detail.provider")) {
            DesignProviderPicker(options: providers, selection: $provider)
              .fixedSize()
              .help(model.localized("desktop.add_account.provider_help"))
              .accessibilityIdentifier("account-flow.provider")
          }

          if showsLocalSourcePicker {
            Picker(model.localized("desktop.nav.apps"), selection: $localSourceID) {
              ForEach(localLoginMethods) { method in
                Text(method.sourceLabel ?? method.label)
                  .tag(method.sourceID ?? "")
              }
            }
            .accessibilityIdentifier("account-flow.local-source")
            .help(model.localized("desktop.add_account.local_app_help"))
          }

          if sourceMode == .paste {
            pasteRows
          } else if isKeyInputMode {
            keyInputRows
          } else {
            currentLoginRow
            if sourceMode == .newAccount, loginMethods.count > 1 {
              Picker(model.localized("desktop.add_account.sign_in_method"), selection: $loginMethod) {
                ForEach(loginMethods) { method in
                  Text(method.label).tag(method.id)
                }
              }
              .accessibilityIdentifier("account-flow.method")
              .help(selectedLoginMethod?.detail ?? "")
            }
            if let blocker = signInBlockerMessage {
              Text(blocker)
                .font(.footnote)
                .foregroundStyle(.secondary)
                .fixedSize(horizontal: false, vertical: true)
                .accessibilityIdentifier("account-flow.blocker")
            }
          }
          TextField(
            model.localized("desktop.account_detail.account_name"),
            text: accountNameBinding,
            prompt: Text(model.localized(sourceMode == .paste ? "desktop.common.optional" : "desktop.add_account.personal_example"))
          )
            .focused($nameFocused)
            .help(model.localized("desktop.add_account.name_help"))
            .accessibilityIdentifier("account-flow.name")
          loginErrorContent
        } footer: {
          Text(sourceFooter)
        }
      }
      .onAppear {
        selectInitialProvider()
        selectDefaultLoginMethod()
        selectDefaultCredential()
        selectDefaultLocalSource()
        syncCurrentLogin()
        if accountName.isEmpty {
          accountName = suggestedAccountName
        }
        nameFocused = true
        if ProcessInfo.processInfo.environment["ANYPICK_MACOS_FLOW"] == "add-account-error" {
          DispatchQueue.main.asyncAfter(deadline: .now() + 0.1) {
            saveError = model.localized("desktop.add_account.fixture_duplicate", replacing: ["name": accountName, "provider": providerLabel])
          }
        }
      }
      .task(id: autoDetectionKey) {
        // Key-input vendors have no live login to detect: probing them only
        // produces a "no live login" error modal over the API-key form.
        guard sourceMode == .thisMac, !provider.isEmpty, !isKeyInputMode else { return }
        await Task.yield()
        guard !Task.isCancelled else { return }
        detectLogin()
      }
      .onChange(of: provider) { _, _ in
        detectedIdentity = ""
        detectedSource = ""
        isVerifying = false
        isDetecting = false
        saveError = nil
        apiSecret = ""
        revealSecret = false
        cloudflareRouting = ""
        authJSON = ""
        nameTouched = false
        replaceExisting = false
        forgetStagedAuth()
        selectDefaultLoginMethod()
        selectDefaultCredential()
        selectDefaultLocalSource()
        if !availableSourceModes.contains(sourceMode) { sourceMode = .thisMac }
        if sourceMode == .thisMac { syncCurrentLogin() }
      }
      .onChange(of: sourceMode) { _, mode in
        isVerifying = false
        isDetecting = false
        saveError = nil
        if mode != .paste {
          replaceExisting = false
          forgetStagedAuth()
        }
        if mode == .paste, !nameTouched {
          accountName = ""
        } else if mode != .paste, !nameTouched, accountName.isEmpty {
          accountName = suggestedAccountName
        }
        if mode == .thisMac {
          selectDefaultLocalSource()
          syncCurrentLogin()
        } else {
          detectedIdentity = ""
          detectedSource = ""
        }
      }
      .onChange(of: authJSON) { previous, next in
        guard previous != next else { return }
        replaceExisting = false
        forgetStagedAuth()
      }
      .onChange(of: localSourceID) { _, _ in
        guard sourceMode == .thisMac else { return }
        detectedIdentity = ""
        detectedSource = ""
        syncCurrentLogin()
      }
      .onChange(of: model.operationResult) { _, result in
        if result?.operation == "account-login" {
          isVerifying = false
          if result?.succeeded == true {
            dismiss()
          } else if let message = result?.message, !message.isEmpty {
            saveError = displaySafeFeedback(
              message,
              fallback: model.localized("desktop.add_account.browser_unreadable")
            )
          } else {
            saveError = model.localized("desktop.add_account.browser_did_not_finish")
          }
        } else if result?.operation == "account-save-input" {
          isVerifying = false
          if result?.succeeded == true {
            dismiss()
          } else if isKeyInputMode {
            // Duplicate names and rejected secrets stay visible in the form.
            if let message = result?.message, !message.isEmpty {
              saveError = displaySafeFeedback(
                message,
              fallback: model.localized("desktop.add_account.provider_unreadable")
              )
            } else {
              saveError = model.localized("desktop.add_account.key_save_error")
            }
          }
        } else if result?.operation == "account-save-auth" {
          isVerifying = false
          if result?.succeeded == true {
            forgetStagedAuth()
            dismiss()
          } else if result?.code == "ACCOUNT_EXISTS" {
            replaceExisting = true
            saveError = displaySafeFeedback(
              result?.message ?? model.localized("desktop.add_account.account_exists"),
              fallback: model.localized("desktop.add_account.account_exists")
            )
          } else if let message = result?.message, !message.isEmpty {
            replaceExisting = false
            saveError = displaySafeFeedback(
              message,
              fallback: model.localized("desktop.add_account.auth_save_error")
            )
          } else {
            replaceExisting = false
            saveError = model.localized("desktop.add_account.auth_save_error")
          }
        } else if result?.operation == "account-save", awaitingSaveResult {
          awaitingSaveResult = false
          if result?.succeeded == true {
            dismiss()
          } else if let message = result?.message, !message.isEmpty {
            saveError = displaySafeFeedback(
              message,
              fallback: model.localized("desktop.add_account.save_error_safe")
            )
          } else {
            saveError = model.localized("desktop.add_account.save_error")
          }
        } else if result?.operation == "account-detect" {
          isDetecting = false
          if result?.succeeded == true {
            syncCurrentLogin(detectionMessage: result?.message)
          } else {
            detectedIdentity = ""
            detectedSource = ""
            saveError = displaySafeFeedback(
              result?.message ?? model.localized("desktop.add_account.no_app_login", replacing: ["app": sourceAppName]),
              fallback: model.localized("desktop.add_account.no_readable_login")
            )
          }
        }
      }
      .onDisappear {
        detectionTask?.cancel()
        loginTask?.cancel()
        if isVerifying { model.cancelAccountLogin() }
      }
      .designConfirmation($confirmation, model: model)
    }
  }

  private func requestSignOut() {
    confirmation = DesignConfirmation(
      id: "sign-out",
      title: model.localized("desktop.add_account.sign_out_title", replacing: ["app": sourceAppName]),
      message:
        model.localized("desktop.add_account.sign_out_message"),
      action: .confirm(model.localized("desktop.add_account.sign_out"), identifier: "account-flow.sign-out") {
        detectedIdentity = ""
        detectedSource = ""
        model.clearLiveLogin(provider: provider)
      }
    )
  }

  private var detectedSourceText: String {
    if !detectedSource.isEmpty { return detectedSource }
    return sourceAppName
  }

  @ViewBuilder
  private var loginErrorContent: some View {
    if let saveError {
      VStack(alignment: .leading, spacing: 8) {
        HStack(alignment: .top, spacing: 8) {
          Image(systemName: "exclamationmark.triangle.fill")
            .foregroundStyle(.orange)
            .font(.subheadline)
            .padding(.top, 1)

          VStack(alignment: .leading, spacing: 4) {
            Text(model.localized("desktop.add_account.unable_to_complete"))
              .font(.subheadline.weight(.semibold))
              .foregroundStyle(.primary)

            Text(
              displaySafeFeedback(
                saveError,
                fallback: model.localized("desktop.add_account.provider_unreadable")
              )
            )
            .font(.footnote)
            .foregroundStyle(.secondary)
            .fixedSize(horizontal: false, vertical: true)
          }
        }

        if sourceMode == .newAccount {
          HStack(spacing: 8) {
            if currentLogin != nil {
              Button(model.localized("desktop.add_account.use_account_this_mac"), action: useCurrentLoginFallback)
                .buttonStyle(.bordered)
                .controlSize(.small)
                .help(model.localized("desktop.add_account.use_detected_login_help"))
            }
            if !credentialKinds.isEmpty {
              Button(model.localized("desktop.add_account.use_api_key"), action: useCredentialFallback)
                .buttonStyle(.bordered)
                .controlSize(.small)
                .help(model.localized("desktop.add_account.switch_api_key_help"))
            }
          }
          .padding(.leading, 24)
        }
      }
      .padding(.vertical, 4)
      .accessibilityIdentifier("account-flow.error")
    }
  }

  private var pasteRows: some View {
    VStack(alignment: .leading, spacing: 6) {
      TextEditor(text: $authJSON)
        .font(.system(.body, design: .monospaced))
        .frame(minHeight: 140)
        .accessibilityIdentifier("account-flow.auth-json")
      Text(model.localized("desktop.add_account.paste_auth_help"))
        .font(.footnote)
        .foregroundStyle(.secondary)
        .fixedSize(horizontal: false, vertical: true)
    }
  }

  private var sourceFooter: String {
    if sourceMode == .paste {
      return
        model.localized("desktop.add_account.paste_auth_footer")
    }
    if isKeyInputMode {
      return
        model.localized("desktop.add_account.api_key_footer", replacing: ["provider": providerLabel])
    }
    if isDetecting { return model.localized("desktop.add_account.detecting_footer") }
    if sourceMode == .thisMac, selectedLocalLoginMethod != nil {
      return
        model.localized("desktop.add_account.local_login_footer", replacing: ["app": sourceAppName])
    }
    if isVerifying || (sourceMode == .newAccount && !hasIdentity) {
      return model.localized("desktop.add_account.browser_save_footer")
    }
    return model.localized("desktop.add_account.switch_back_footer")
  }

  private var identityTitle: String {
    if isDetecting || isVerifying { return model.localized("desktop.add_account.checking_app", replacing: ["app": sourceAppName]) }
    if hasIdentity { return detectedIdentity }
    if sourceMode == .newAccount { return sourceAppName }
    return model.localized("desktop.add_account.no_login_this_mac")
  }

  private var identityDetail: String {
    if isDetecting || isVerifying { return model.localized("desktop.add_account.checking_wait") }
    if hasIdentity {
      if sourceMode == .thisMac { return model.localized("desktop.add_account.detected_on_this_mac", replacing: ["source": detectedSourceText]) }
      return detectedSourceText
    }
    if sourceMode == .newAccount {
      return isCommunityFlow
        ? model.localized("desktop.add_account.community_browser_flow", replacing: ["provider": providerLabel])
        : model.localized("desktop.add_account.official_browser_flow", replacing: ["provider": providerLabel])
    }
    // WorkBuddy shares its login with its desktop app through the session
    // file, so "On This Mac" sees the app's current login — first-timers
    // without one use New Account.
    if isWorkBuddyProvider {
      return workBuddyAppInstalled
        ? model.localized("desktop.add_account.workbuddy_installed")
        : model.localized("desktop.add_account.workbuddy_new_account")
    }
    if isZaiProvider {
      return zcodeAppInstalled
        ? model.localized("desktop.add_account.zcode_not_detected")
        : model.localized("desktop.add_account.zai_new_account")
    }
    return sourceAppName
  }

  private var showsSignOutMenu: Bool {
    sourceMode == .thisMac && selectedProvider?.canClear == true && currentLogin != nil
  }

  private var checkAgainHelp: String {
    if sourceMode == .newAccount, !hasIdentity {
      return isCommunityFlow
        ? model.localized("desktop.add_account.community_browser_flow", replacing: ["provider": providerLabel])
        : model.localized("desktop.add_account.official_browser_flow", replacing: ["provider": providerLabel])
    }
    return model.localized("desktop.add_account.check_current_account", replacing: ["app": sourceAppName])
  }

  private var currentLoginRow: some View {
    HStack(spacing: 10) {
      DesignProviderIcon(
        provider: providerIconID,
        fallbackSymbol: DesignBrandAsset.fallbackSymbol(for: providerIconID),
        size: 28
      )
      VStack(alignment: .leading, spacing: 2) {
        Text(identityTitle)
          .fontWeight(.medium)
          .lineLimit(1)
        if !identityDetail.isEmpty {
          Text(identityDetail)
            .font(.subheadline)
            .foregroundStyle(.secondary)
            .lineLimit(1)
        }
      }
      .frame(maxWidth: .infinity, alignment: .leading)
      loginAccessories
    }
    .accessibilityElement(children: .contain)
    .accessibilityIdentifier("account-flow.identity")
  }

  private var keyInputRows: some View {
    Group {
      if credentialKinds.count > 1 {
        Picker(model.localized("desktop.add_account.credential"), selection: $credentialKind) {
          ForEach(credentialKinds) { kind in
            Text(kind.label).tag(kind.kind)
          }
        }
        .accessibilityIdentifier("account-flow.credential-kind")
        .help(model.localized("desktop.add_account.credential_help"))
        .onChange(of: credentialKind) { _, _ in credentialProfile = "" }
      }
      if availableProfiles.count > 1 {
        Picker(model.localized("desktop.add_account.profile"), selection: $credentialProfile) {
          ForEach(availableProfiles) { profile in
            Text(profile.label).tag(profile.id)
          }
        }
        .accessibilityIdentifier("account-flow.credential-profile")
        .help(model.localized("desktop.add_account.profile_help"))
      }
      if isCloudflareProvider {
        // The gateway base URL embeds the Cloudflare account id, so no fixed
        // profile preset can name it. Collect the routing pair as typed input
        // and send it as the credential profile.
        LabeledContent(model.localized("desktop.add_account.account_gateway")) {
          TextField("<account_id>/<gateway_id>", text: $cloudflareRouting)
            .labelsHidden()
            .help(model.localized("desktop.add_account.cloudflare_route_help"))
            .accessibilityIdentifier("account-flow.cloudflare-routing")
        }
        Text(
          model.localized("desktop.add_account.cloudflare_hint")
        )
        .font(.footnote)
        .foregroundStyle(.secondary)
        .fixedSize(horizontal: false, vertical: true)
        .accessibilityIdentifier("account-flow.cloudflare-hint")
      }
      LabeledContent(selectedCredentialKind?.label ?? model.localized("desktop.common.api_key")) {
        HStack(spacing: 8) {
          Group {
            if revealSecret {
              TextField("", text: $apiSecret)
            } else {
              SecureField("", text: $apiSecret)
            }
          }
          .labelsHidden()
          .help(model.localized("desktop.add_account.credential_input_help"))
          .accessibilityIdentifier("account-flow.api-key")

          DesignIconButton(
            symbol: revealSecret ? "eye.slash" : "eye",
            label: model.localized(revealSecret ? "desktop.gateway.hide_api_key" : "desktop.gateway.show_api_key"),
            identifier: "account-flow.toggle-key-visibility"
          ) {
            revealSecret.toggle()
          }
        }
      }
      if isZaiProvider {
        // Keep the explicit key path visible even though ZCode and browser
        // subscription sign-in are also available as separate source modes.
        Text(
          zcodePlanWarning
            ?? model.localized("desktop.add_account.zcode_plan_hint")
        )
        .font(.footnote)
        .foregroundStyle(.secondary)
        .fixedSize(horizontal: false, vertical: true)
        .accessibilityIdentifier("account-flow.zcode-hint")
      }
    }
  }

  private var loginAccessories: some View {
    HStack(spacing: 4) {
      if isDetecting || isVerifying {
        ProgressView()
          .controlSize(.small)
          .accessibilityLabel(model.localized("desktop.common.checking"))
      } else {
        Button {
          if sourceMode == .newAccount, !hasIdentity { signIn() } else { detectLogin() }
        } label: {
          Image(
            systemName: sourceMode == .newAccount && !hasIdentity
              ? "arrow.up.right.square"
              : "arrow.clockwise"
          )
        }
        .buttonStyle(.bordered)
        .controlSize(.small)
        .disabled(model.isBusy)
        .help(checkAgainHelp)
        .accessibilityLabel(
          model.localized(sourceMode == .newAccount && !hasIdentity ? "desktop.add_account.start_sign_in" : "desktop.add_account.check_again")
        )
        .accessibilityIdentifier("account-flow.detect")
      }
      if showsSignOutMenu {
        DesignMoreActionsMenu(
          label: model.localized("desktop.add_account.account_actions"),
          identifier: "account-flow.clear",
          isDisabled: model.isBusy
        ) {
          Button(model.localized("desktop.add_account.sign_out_this_mac"), role: .destructive) { requestSignOut() }
            .help(model.localized("desktop.add_account.sign_out_help"))
        }
      }
    }
  }

  private func syncCurrentLogin(detectionMessage: String? = nil) {
    if let login = currentLogin {
      let currentLoginLabel = model.localized("desktop.app_detail.current_login")
      detectedIdentity = displaySafeIdentity(login.identity ?? currentLoginLabel) ?? currentLoginLabel
      detectedSource = localLoginSourceName ?? login.appName
      return
    }
    let detected = accountIdentity(fromDetectionMessage: detectionMessage) ?? ""
    detectedIdentity = displaySafeIdentity(
      detected == "Current login" ? model.localized("desktop.app_detail.current_login") : detected
    ) ?? ""
    detectedSource = detectedIdentity.isEmpty ? "" : sourceAppName
  }

  private func liveLogin(for option: DesignProviderOption?) -> DesignLiveLogin? {
    guard let option else { return nil }
    let matches = model.currentLiveLogins.filter {
      $0.id.caseInsensitiveCompare(option.id) == .orderedSame
        || ($0.sourceID == nil
          && $0.providerID.caseInsensitiveCompare(option.id) == .orderedSame)
        || $0.providerName.caseInsensitiveCompare(option.label) == .orderedSame
    }
    if sourceMode == .thisMac, !localSourceID.isEmpty {
      return matches.first {
        $0.sourceID?.caseInsensitiveCompare(localSourceID) == .orderedSame
      }
    }
    return matches.first
  }

  private func broadLiveLogin(for option: DesignProviderOption?) -> DesignLiveLogin? {
    guard let option else { return nil }
    return model.currentLiveLogins.first {
      $0.id.caseInsensitiveCompare(option.id) == .orderedSame
        || ($0.sourceID == nil
          && $0.providerID.caseInsensitiveCompare(option.id) == .orderedSame)
        || $0.providerName.caseInsensitiveCompare(option.label) == .orderedSame
    }
  }

  private func selectInitialProvider() {
    let enabledProviders = providers.filter(\.enabled)
    guard !enabledProviders.isEmpty else {
      provider = ""
      return
    }
    if let liveProvider = enabledProviders.first(where: { liveLogin(for: $0) != nil }) {
      provider = liveProvider.id
    } else if !enabledProviders.contains(where: { $0.id == provider }) {
      // Native sign-in first: key-only vendors sort before "claude", so the
      // raw first-enabled row would default the sheet to an API-key form.
      provider =
        enabledProviders.first(where: { !$0.loginMethods.isEmpty })?.id
        ?? enabledProviders[0].id
    }
  }

  private var suggestedAccountName: String {
    let existing = model.accounts.filter {
      $0.kind == .saved && $0.provider.caseInsensitiveCompare(provider) == .orderedSame
    }.map(\.name)
    let workName = model.localized("desktop.add_account.work_example")
    let personalName = model.localized("desktop.add_account.personal_example")
    if !existing.contains(where: { $0.caseInsensitiveCompare(workName) == .orderedSame }) {
      return workName
    }
    if !existing.contains(where: { $0.caseInsensitiveCompare(personalName) == .orderedSame }) {
      return personalName
    }
    return model.localized("desktop.add_account.account_number", replacing: ["number": String(existing.count + 1)])
  }

  private func detectLogin() {
    isDetecting = true
    if model.isProduction {
      if !model.detectSavedAccount(
        provider: provider,
        sourceID: selectedLocalLoginMethod?.sourceID
      ) {
        isDetecting = false
      }
      return
    }
    detectionTask?.cancel()
    detectionTask = Task { @MainActor in
      try? await Task.sleep(nanoseconds: 650_000_000)
      guard !Task.isCancelled else { return }
      if let login = currentLogin {
        detectedIdentity = displaySafeIdentity(login.identity ?? "") ?? ""
        detectedSource = localLoginSourceName ?? login.appName
      } else {
        detectedIdentity = ""
        detectedSource = ""
      }
      isDetecting = false
    }
  }

  private func selectDefaultLoginMethod() {
    loginMethod =
      loginMethods.first(where: {
        $0.provenance == "official" && $0.preferred && $0.available
      })?.id
      ?? loginMethods.first(where: { $0.provenance == "official" && $0.available })?.id
      ?? loginMethods.first(where: { $0.preferred && $0.available })?.id
      ?? loginMethods.first(where: \.available)?.id
      ?? loginMethods.first?.id
      ?? ""
  }

  private func selectDefaultLocalSource() {
    guard !localLoginMethods.isEmpty else {
      localSourceID = ""
      return
    }
    if let sourceID = broadLiveLogin(for: selectedProvider)?.sourceID,
      localLoginMethods.contains(where: {
        $0.sourceID?.caseInsensitiveCompare(sourceID) == .orderedSame
      })
    {
      localSourceID = sourceID
      return
    }
    if !localLoginMethods.contains(where: {
      $0.sourceID?.caseInsensitiveCompare(localSourceID) == .orderedSame
    }) {
      localSourceID = localLoginMethods.first?.sourceID ?? ""
    }
  }

  private func selectDefaultCredential() {
    if !credentialKinds.contains(where: { $0.kind == credentialKind }) {
      credentialKind = credentialKinds.first?.kind ?? ""
    }
    if !availableProfiles.contains(where: { $0.id == credentialProfile }) {
      credentialProfile = availableProfiles.first?.id ?? ""
    }
  }

  private func submit() {
    if sourceMode == .paste {
      savePaste()
      return
    }
    if isKeyInputMode {
      saveKey()
      return
    }
    if sourceMode == .newAccount, !hasIdentity {
      signIn()
      return
    }
    save()
  }

  private func saveKey() {
    guard let kind = selectedCredentialKind else { return }
    saveError = nil
    isVerifying = true
    // Fixed presets cannot name a per-account gateway base: the typed routing
    // pair is the profile for this provider.
    let profile =
      isCloudflareProvider ? cloudflareRoutingTrimmed : selectedProfileID
    if model.isProduction {
      if !model.saveCredentialInput(
        provider: provider,
        name: accountName,
        kind: kind.kind,
        profile: profile,
        secret: apiSecret
      ) {
        isVerifying = false
      }
      return
    }
    isVerifying = false
    if model.saveCredentialInput(
      provider: provider,
      name: accountName,
      kind: kind.kind,
      profile: profile,
      secret: apiSecret
    ) {
      dismiss()
    }
  }

  private func signIn() {
    guard let method = selectedLoginMethod else {
      isVerifying = false
      saveError = model.localized("desktop.add_account.choose_sign_in_method")
      return
    }
    saveError = nil
    model.dismissFeedback()
    isVerifying = true
    if model.isProduction {
      if !model.loginSavedAccount(
        provider: provider,
        name: accountName,
        label: "",
        methodId: method.id
      ) {
        isVerifying = false
        saveError = loginFailureMessage(
          fallback: model.localized("desktop.add_account.browser_start_error")
        )
      }
      return
    }
    loginTask?.cancel()
    loginTask = Task { @MainActor in
      try? await Task.sleep(nanoseconds: 800_000_000)
      guard !Task.isCancelled else { return }
      let identity =
        switch provider {
        case "Claude": "alex@personal.example"
        case "OpenAI": "codex@company.example"
        case "Gemini": "builder@company.example"
        default: "signed-in-\(provider.lowercased())"
        }
      model.upsertLiveLogin(provider: provider, identity: identity, appName: sourceAppName)
      let saved = model.loginSavedAccount(
        provider: provider,
        name: accountName,
        label: "",
        methodId: method.id
      )
      isVerifying = false
      if saved {
        dismiss()
      } else {
        saveError = loginFailureMessage(
          fallback: model.localized("desktop.add_account.browser_save_error")
        )
      }
    }
  }

  private func loginFailureMessage(fallback: String) -> String {
    let message = model.feedback?.message
    model.dismissFeedback()
    return displaySafeFeedback(message ?? fallback, fallback: fallback)
  }

  private func savePaste() {
    let body = authJSON.trimmingCharacters(in: .whitespacesAndNewlines)
    guard !body.isEmpty else { return }
    saveError = nil
    let path: String
    if replaceExisting, let staged = stagedAuthPath {
      path = staged
    } else {
      do {
        forgetStagedAuth()
        path = try AuthPasteFiles.stage(body)
        stagedAuthPath = path
      } catch let error as AuthPasteWriteError {
        saveError = model.localized(error.localizationKey)
        return
      } catch {
        saveError = model.localized("desktop.add_account.auth_write_error")
        return
      }
    }
    let typed = accountName.trimmingCharacters(in: .whitespacesAndNewlines)
    let name = nameTouched && !typed.isEmpty ? typed : nil
    isVerifying = true
    let accepted = model.savePastedAuth(
      provider: provider,
      name: name,
      path: path,
      overwrite: replaceExisting
    )
    if !model.isProduction || !accepted {
      isVerifying = false
    }
  }

  private func forgetStagedAuth() {
    if let path = stagedAuthPath {
      AuthPasteFiles.forget(path)
    }
    stagedAuthPath = nil
  }

  private func cancelAndDismiss() {
    detectionTask?.cancel()
    loginTask?.cancel()
    if isVerifying { model.cancelAccountLogin() }
    isDetecting = false
    isVerifying = false
    forgetStagedAuth()
    dismiss()
  }

  private func useCurrentLoginFallback() {
    sourceMode = .thisMac
    saveError = nil
    syncCurrentLogin()
    if currentLogin == nil {
      detectLogin()
    }
  }

  private func useCredentialFallback() {
    guard !credentialKinds.isEmpty else { return }
    sourceMode = .credential
    saveError = nil
    selectDefaultCredential()
  }

  private func save() {
    let identity =
      detectedIdentity.isEmpty
      ? model.localized("desktop.add_account.current_provider_login", replacing: ["provider": providerLabel])
      : detectedIdentity
    saveError = nil
    if model.isProduction {
      // Dismissal waits for the engine result; the fixture answers
      // synchronously and dismisses at once below.
      if model.addSavedAccount(
        provider: provider,
        name: accountName,
        label: "",
        identity: identity,
        sourceID: selectedLocalLoginMethod?.sourceID
      ) {
        awaitingSaveResult = true
      }
      return
    }
    if model.addSavedAccount(
      provider: provider,
      name: accountName,
      label: "",
      identity: identity,
      sourceID: selectedLocalLoginMethod?.sourceID
    ) {
      dismiss()
    }
  }
}

/// Temp files for pasted auth JSON. The desktop command carries the path.
/// The document never goes on the mutate line, and this helper never deletes
/// a path whose parent is not the directory it created. A sibling named
/// `anypick-auth-paste-evil` shares the prefix and must still be refused.
enum AuthPasteFiles {
  static let directoryName = "anypick-auth-paste"
  static let maxBytes = 256 * 1024

  static func stage(_ text: String) throws -> String {
    let data = Data(text.utf8)
    if data.count > maxBytes {
      throw AuthPasteWriteError(localizationKey: "desktop.add_account.auth_too_large")
    }
    let directory = try directoryURL()
    let file = directory.appendingPathComponent(UUID().uuidString + ".json")
    guard FileManager.default.createFile(atPath: file.path, contents: data) else {
      throw AuthPasteWriteError(localizationKey: "desktop.add_account.auth_write_error")
    }
    try FileManager.default.setAttributes(
      [.posixPermissions: NSNumber(value: Int16(0o600))],
      ofItemAtPath: file.path
    )
    return file.path
  }

  /// Missing files succeed. A symlink, or any path outside the paste directory, is left in place.
  static func forget(_ path: String) {
    let manager = FileManager.default
    guard let directory = try? directoryURL() else { return }
    if (try? manager.destinationOfSymbolicLink(atPath: path)) != nil { return }
    guard
      let realDirectory = try? directory.resolvingSymlinksInPath().standardizedFileURL
    else { return }
    let parent = URL(fileURLWithPath: path)
      .deletingLastPathComponent()
      .resolvingSymlinksInPath()
      .standardizedFileURL
    guard parent.path == realDirectory.path else { return }
    guard manager.fileExists(atPath: path) else { return }
    try? manager.removeItem(atPath: path)
  }

  private static func directoryURL() throws -> URL {
    let url = FileManager.default.temporaryDirectory
      .appendingPathComponent(directoryName, isDirectory: true)
    try FileManager.default.createDirectory(at: url, withIntermediateDirectories: true)
    try FileManager.default.setAttributes(
      [.posixPermissions: NSNumber(value: Int16(0o700))],
      ofItemAtPath: url.path
    )
    return url
  }
}

struct AuthPasteWriteError: Error {
  let localizationKey: String
}
