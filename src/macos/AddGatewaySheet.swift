import SwiftUI

struct AddGatewaySheet: View {
  @ObservedObject var model: MacOSDesignModel
  private let targetClientID: String?
  private let onCreated: () -> Void
  @Environment(\.dismiss) private var dismiss
  @State private var provider: String
  @State private var gatewayName = ""
  @State private var endpoint = ""
  @State private var apiKey = ""
  @State private var gatewayID = ""
  @State private var accountID = ""
  @State private var revealKey = false
  @State private var connectionState: ConnectionState = .untested
  @State private var connectionMessage = ""
  @FocusState private var focusedField: Field?

  private enum Field: Hashable { case name, endpoint, apiKey, accountID, gatewayID }
  private enum ConnectionState { case untested, testing, available, unavailable }
  private var providers: [DesignProviderOption] { model.gatewayProviderOptions }
  private var selectedProvider: DesignProviderOption? { providers.first { $0.id == provider } }
  private var inferredProvider: DesignProviderOption? {
    model.preferredGatewayProvider(for: targetClientID)
  }
  private var suppliedEndpoint: String? { model.defaultGatewayEndpoint(for: provider) }
  private var providerSuppliesEndpoint: Bool {
    selectedProvider?.providesEndpoint == true || suppliedEndpoint != nil
  }
  private var usesCustomEndpoint: Bool { !providerSuppliesEndpoint }

  init(
    model: MacOSDesignModel,
    targetClientID: String? = nil,
    onCreated: @escaping () -> Void = {}
  ) {
    self.model = model
    self.targetClientID = targetClientID
    self.onCreated = onCreated
    let initial =
      model.preferredGatewayProvider(for: targetClientID)
      ?? model.gatewayProviderOptions.first
    _provider = State(initialValue: initial?.id ?? "")
    let isErrorFlow = ProcessInfo.processInfo.environment["ANYPICK_MACOS_FLOW"] == "add-gateway-error"
    _connectionState = State(initialValue: isErrorFlow ? .unavailable : .untested)
    _connectionMessage = State(
      initialValue: isErrorFlow
        ? model.localized("desktop.gateway.error_unreachable")
        : ""
    )
  }

  private var resolvedEndpoint: String {
    suppliedEndpoint ?? (providerSuppliesEndpoint ? "" : endpoint)
  }

  private var canSave: Bool {
    !gatewayName.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty
      && (requiresApiKey
        ? !apiKey.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty
        : true)
      && selectedProvider != nil
      && (usesCustomEndpoint
        ? !endpoint.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty
        : true)
      && (!requiresAccountId
        || !accountID.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty)
  }

  private var requiresApiKey: Bool { selectedProvider?.requiresApiKey ?? true }
  private var requiresAccountId: Bool { selectedProvider?.requiresAccountId == true }

  var body: some View {
    DesignSheetHost(
      model: model,
      title: model.localized("desktop.gateway.add_title"),
      width: 456,
      primaryTitle: model.localized("desktop.gateway.add_action"),
      primaryDisabled: !canSave || model.isBusy,
      primaryIdentifier: "gateway-flow.save",
      primaryHelp: model.localized("desktop.gateway.add_help"),
      onCancel: { dismiss() },
      onPrimary: save
    ) {
      Form {
          Section {
            LabeledContent(model.localized("desktop.account_detail.provider")) {
              if let inferredProvider {
                Label {
                  Text(inferredProvider.label)
                } icon: {
                  DesignProviderIcon(
                    provider: inferredProvider.id,
                    fallbackSymbol: DesignBrandAsset.fallbackSymbol(for: inferredProvider.id),
                    size: 16
                  )
                }
                .fixedSize()
              } else {
                DesignProviderPicker(
                  options: providers,
                  selection: $provider,
                  accessibilityIdentifier: "gateway-flow.provider",
                  groupsProviders: true,
                  hostedGroupTitle: model.localized("desktop.gateway.hosted"),
                  selfHostedGroupTitle: model.localized("desktop.gateway.self_hosted_custom")
                )
                .help(model.localized("desktop.gateway.choose_provider_help"))
              }
            }
            LabeledContent(model.localized("desktop.account_detail.name")) {
              TextField(
                "", text: $gatewayName,
                prompt: Text(model.localized(usesCustomEndpoint ? "desktop.gateway.name_example_custom" : "desktop.gateway.name_example"))
              )
              .labelsHidden()
              .focused($focusedField, equals: .name)
              .help(model.localized("desktop.gateway.name_help"))
              .accessibilityIdentifier("gateway-flow.name")
            }
          } footer: {
            Text(
              model.localized("desktop.gateway.provider_fields_help")
            )
          }

          Section {
            if requiresApiKey {
              LabeledContent(model.localized("desktop.common.api_key")) {
                HStack(spacing: 8) {
                  Group {
                    if revealKey {
                      TextField("", text: $apiKey)
                    } else {
                      SecureField("", text: $apiKey)
                    }
                  }
                  .labelsHidden()
                  .focused($focusedField, equals: .apiKey)
                  .help(model.localized("desktop.gateway.enter_api_key_help"))
                  .accessibilityIdentifier("gateway-flow.api-key")

                  DesignIconButton(
                    symbol: revealKey ? "eye.slash" : "eye",
                    label: model.localized(revealKey ? "desktop.gateway.hide_api_key" : "desktop.gateway.show_api_key"),
                    identifier: "gateway-flow.toggle-key-visibility"
                  ) {
                    revealKey.toggle()
                  }
                }
              }
            } else {
              LabeledContent(model.localized("desktop.gateway.credentials")) {
                Text(model.localized("desktop.gateway.grok_login_help"))
                  .font(.footnote)
                  .foregroundStyle(.secondary)
              }
              LabeledContent(model.localized("desktop.gateway.setup")) {
                Text(model.localized("desktop.gateway.grok_setup"))
                  .font(.footnote)
                  .foregroundStyle(.secondary)
              }
            }
            if requiresAccountId {
              LabeledContent(model.localized("desktop.gateway.account_id")) {
                TextField("", text: $accountID, prompt: Text(model.localized("desktop.gateway.account_id_prompt")))
                  .labelsHidden()
                  .focused($focusedField, equals: .accountID)
                  .accessibilityIdentifier("gateway-flow.account-id")
                  .textContentType(.none)
                  .autocorrectionDisabled()
                  .help(model.localized("desktop.gateway.account_id_help"))
              }
            }
            if selectedProvider?.requiresGatewayId == true {
              LabeledContent(model.localized("desktop.gateway.gateway_id")) {
              TextField(
                "", text: $gatewayID,
                prompt: Text(model.localized("desktop.app_detail.default"))
              )
                  .labelsHidden()
                  .accessibilityIdentifier("gateway-flow.gateway-id")
                  .help(model.localized("desktop.gateway.gateway_id_help"))
              }
            }
            if providerSuppliesEndpoint {
              LabeledContent(
                model.localized("desktop.proxy_detail.endpoint"),
                value: suppliedEndpoint ?? model.localized("desktop.gateway.provided_by", replacing: ["provider": selectedProvider?.label ?? provider])
              )
            } else {
              LabeledContent(model.localized("desktop.proxy_detail.endpoint")) {
                TextField("", text: $endpoint, prompt: Text(model.localized("desktop.gateway.endpoint_example")))
                  .labelsHidden()
                  .focused($focusedField, equals: .endpoint)
                  .help(model.localized("desktop.gateway.endpoint_help"))
                  .accessibilityIdentifier("gateway-flow.endpoint")
              }
            }
            LabeledContent(model.localized("desktop.app_detail.connection")) {
              connectionControl
            }
          } header: {
            Text(model.localized("desktop.gateway.credentials"))
          } footer: {
            Text(connectionFooter)
          }
      }
      .onAppear {
        if let inferredProvider {
          provider = inferredProvider.id
        } else if !providers.contains(where: { $0.id == provider }) {
          provider = providers.first?.id ?? ""
        }
        endpoint = suppliedEndpoint ?? ""
        if gatewayName.isEmpty { gatewayName = suggestedGatewayName }
        focusedField = .name
        if ProcessInfo.processInfo.environment["ANYPICK_MACOS_FLOW"] == "add-gateway-error" {
          DispatchQueue.main.asyncAfter(deadline: .now() + 0.1) {
            connectionState = .unavailable
            connectionMessage = model.localized("desktop.gateway.error_unreachable")
          }
        }
      }
      .onChange(of: provider) {
        resetConnectionTest()
        endpoint = suppliedEndpoint ?? ""
      }
      .onChange(of: endpoint) { resetConnectionTest() }
      .onChange(of: apiKey) { resetConnectionTest() }
      .onChange(of: accountID) { resetConnectionTest() }
      .onChange(of: model.operationResult) { _, result in
        guard result?.operation == "gateway-test", connectionState == .testing else { return }
        connectionState = result?.succeeded == true ? .available : .unavailable
        connectionMessage = result?.message ?? ""
      }
    }
  }

  @ViewBuilder
  private var connectionControl: some View {
    switch connectionState {
    case .testing:
      HStack(spacing: 6) {
        ProgressView()
          .controlSize(.small)
          .accessibilityLabel(model.localized("desktop.gateway.testing_connection"))
        Button(model.localized("desktop.common.test_connection"), action: {})
          .buttonStyle(.bordered)
          .controlSize(.small)
          .help(model.localized("desktop.gateway.test_running_help"))
          .disabled(true)
      }
      .accessibilityIdentifier("gateway-flow.testing")
    case .available:
      HStack(spacing: 10) {
        Label(model.localized("desktop.gateway.connected"), systemImage: "checkmark.circle.fill")
          .foregroundStyle(.green)
        Button(model.localized("desktop.gateway.test_again"), action: testConnection)
          .buttonStyle(.bordered)
          .controlSize(.small)
          .help(model.localized("desktop.gateway.test_again_help"))
      }
      .accessibilityIdentifier("gateway-flow.available")
    case .unavailable:
      HStack(spacing: 10) {
        Label(model.localized("desktop.gateway.not_connected"), systemImage: "exclamationmark.circle.fill")
          .foregroundStyle(.red)
        Button(model.localized("desktop.common.try_again"), action: testConnection)
          .buttonStyle(.bordered)
          .controlSize(.small)
          .help(model.localized("desktop.gateway.retry_test_help"))
      }
      .accessibilityIdentifier("gateway-flow.unavailable")
    case .untested:
      Button(model.localized("desktop.common.test_connection"), action: testConnection)
        .buttonStyle(.bordered)
        .controlSize(.small)
        .help(model.localized("desktop.gateway.check_connection_help"))
        .disabled(
          !gatewayConnectionTestEnabled(
            requiresApiKey: requiresApiKey, apiKey: apiKey, isBusy: model.isBusy,
            requiresAccountId: requiresAccountId, accountID: accountID)
        )
        .accessibilityIdentifier("gateway-flow.test")
    }
  }

  private var connectionFooter: String {
    switch connectionState {
    case .testing:
      return resolvedEndpoint.isEmpty
        ? model.localized("desktop.gateway.contacting_provider", replacing: ["provider": selectedProvider?.label ?? provider])
        : model.localized("desktop.gateway.contacting_endpoint", replacing: ["endpoint": resolvedEndpoint])
    case .available:
      return connectionMessage.isEmpty
        ? model.localized("desktop.gateway.connected_success") : connectionMessage
    case .unavailable:
      return connectionMessage.isEmpty
        ? model.localized("desktop.gateway.could_not_connect")
        : connectionMessage
    case .untested:
      if requiresAccountId {
        return model.localized("desktop.gateway.derived_endpoint_help")
      }
      if !usesCustomEndpoint {
        return
          model.localized("desktop.gateway.provider_endpoint_help", replacing: ["provider": selectedProvider?.label ?? provider])
      }
      return model.localized("desktop.gateway.detect_format_help")
    }
  }

  private func testConnection() {
    guard connectionState != .testing else { return }
    connectionState = .testing
    connectionMessage = ""
    let accepted = model.testGateway(
      provider: provider,
      endpoint: resolvedEndpoint,
      apiKey: apiKey,
      profile: requiresAccountId ? accountID.trimmingCharacters(in: .whitespacesAndNewlines) : nil
    )
    if !model.isProduction {
      connectionState = accepted ? .available : .unavailable
      connectionMessage =
        accepted
        ? model.localized("desktop.gateway.fixture_connected")
        : model.localized("desktop.gateway.fixture_rejected_key")
    } else if !accepted {
      connectionState = .unavailable
      connectionMessage = model.localized("desktop.gateway.test_could_not_start")
    }
  }

  private func resetConnectionTest() {
    connectionState = .untested
    connectionMessage = ""
  }

  private func save() {
    if model.addGateway(
      provider: provider,
      name: gatewayName,
      label: "",
      endpoint: resolvedEndpoint,
      apiKey: apiKey,
      gatewayId: gatewayID.trimmingCharacters(in: .whitespacesAndNewlines),
      profile: requiresAccountId ? accountID.trimmingCharacters(in: .whitespacesAndNewlines) : nil,
      defaultModel: ""
    ) {
      onCreated()
      dismiss()
    }
  }

  private var suggestedGatewayName: String {
    if !model.accounts.contains(where: {
      $0.name.caseInsensitiveCompare("Production") == .orderedSame
    }) {
      return "Production"
    }
    let base = selectedProvider?.label ?? "Gateway"
    var suffix = 2
    while model.accounts.contains(where: {
      $0.name.caseInsensitiveCompare("\(base) \(suffix)") == .orderedSame
    }) {
      suffix += 1
    }
    return "\(base) \(suffix)"
  }
}
