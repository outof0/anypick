import AppKit
import SwiftUI

struct ProxyDetailView: View {
  @ObservedObject var model: MacOSDesignModel
  let proxyID: String
  @State private var didCopy = false
  @State private var didCopyApiKey = false
  @State private var confirmation: DesignConfirmation?

  private var proxy: DesignProxy? { model.proxies.first { $0.id == proxyID } }

  var body: some View {
    Group {
      if let proxy {
        DesignGroupedPane(
          actions: {
            proxyActions(for: proxy)
          }
        ) {
          Section {
            Label {
              VStack(alignment: .leading, spacing: 2) {
                Text(proxy.name)
                Text(purpose)
                  .foregroundStyle(.secondary)
              }
            } icon: {
              DesignProviderIcon(provider: proxy.provider, fallbackSymbol: proxy.symbol)
            }
            LabeledContent(model.localized("desktop.common.status")) {
              HStack(spacing: 8) {
                if let operation = model.serviceOperations[proxy.id] {
                  HStack(spacing: 6) {
                    ProgressView()
                      .controlSize(.small)
                    Text(operation.localizedLabel(using: model))
                      .foregroundStyle(.secondary)
                  }
                } else {
                  DesignStatusLabel(model: model, status: proxy.status)
                }
                proxyLifecycleAction(proxy)
              }
            }
            LabeledContent(model.localized("desktop.account_detail.provider"), value: providerName)
            if !servingAccountDisplay.isEmpty {
              LabeledContent(model.localized("desktop.proxy_detail.serving_account"), value: servingAccountDisplay)
            }
          } header: {
            Text(model.localized("desktop.proxy_detail.service"))
          }

          if let failure = model.serviceFailures[proxy.id] {
            Section {
              Label {
                VStack(alignment: .leading, spacing: 2) {
                  Text(model.localized("desktop.proxy_detail.service_error"))
                  Text(failure)
                    .foregroundStyle(.secondary)
                }
              } icon: {
                DesignWarningSymbol()
              }
            } footer: {
              Text(model.localized("desktop.proxy_detail.service_error_help"))
            }
          } else if proxy.status == .attention {
            Section {
              Label {
                VStack(alignment: .leading, spacing: 2) {
                  Text(model.localized("desktop.common.needs_attention"))
                  Text(model.localized("desktop.proxy_detail.enabled_not_running"))
                    .foregroundStyle(.secondary)
                }
              } icon: {
                DesignWarningSymbol()
              }
            } footer: {
              Text(model.localized("desktop.proxy_detail.start_relay_help"))
            }
          }

          Section {
            LabeledContent(model.localized("desktop.common.address")) {
              if proxy.port > 0 {
                HStack(spacing: 8) {
                  Text("http://127.0.0.1:\(proxy.port)")
                    .font(.system(.body, design: .monospaced))
                    .foregroundStyle(.secondary)
                    .textSelection(.enabled)
                  DesignCopyButton(
                    copied: didCopy,
                    label: model.localized("desktop.common.copy_address"),
                    copiedLabel: model.localized("desktop.common.copied_to_clipboard"),
                    identifier: "proxies.inspector.copy",
                    action: copyAddress
                  )
                }
              } else {
                Text(model.localized("desktop.proxy_detail.not_running"))
                  .foregroundStyle(.secondary)
                  .accessibilityIdentifier("proxies.inspector.address")
              }
            }
            if proxy.port > 0 && model.proxyCanCopyAPIKey(proxy) {
              LabeledContent(model.localized("desktop.common.api_key")) {
                HStack(spacing: 8) {
                  if proxy.apiKey.isEmpty {
                    Text(model.localized("desktop.proxy_detail.hidden_until_copied"))
                      .foregroundStyle(.secondary)
                  } else {
                    Text(proxy.apiKey)
                      .font(.system(.body, design: .monospaced))
                      .foregroundStyle(.secondary)
                      .lineLimit(1)
                      .truncationMode(.middle)
                      .textSelection(.enabled)
                  }
                  DesignCopyButton(
                    copied: didCopyApiKey,
                    label: model.localized("desktop.common.copy_api_key"),
                    copiedLabel: model.localized("desktop.common.copied_to_clipboard"),
                    identifier: "proxies.inspector.copy-key",
                    action: { model.copyProxyAPIKey(id: proxy.id) }
                  )
                  if proxy.status == .running {
                    DesignIconButton(
                      symbol: "arrow.triangle.2.circlepath",
                      label: model.localized("desktop.common.rotate_key"),
                      identifier: "proxies.inspector.rotate-key",
                      action: requestRotate
                    )
                  }
                }
              }
            }
            if proxy.port > 0 {
              LabeledContent(model.localized("desktop.proxy_detail.port"), value: "\(proxy.port)")
            }
            LabeledContent(model.localized("desktop.proxy_detail.security"), value: model.localized("desktop.proxy_detail.loopback_authenticated"))
            LabeledContent(model.localized("desktop.proxy_detail.activity_logs")) {
              Button {
                model.destination = .activity
              } label: {
                HStack(spacing: 4) {
                  Text(model.localized("desktop.proxy_detail.view_in_activity"))
                  Image(systemName: "arrow.up.forward.app")
                    .font(.caption2)
                }
              }
              .buttonStyle(.plain)
              .help(model.localized("desktop.proxy_detail.open_activity_help"))
              .foregroundStyle(Color.accentColor)
            }
          } header: {
            Text(model.localized("desktop.proxy_detail.endpoint"))
          } footer: {
            Text(model.proxyCanCopyAPIKey(proxy)
              ? model.localized("desktop.proxy_detail.loopback_key_detail")
              : model.localized("desktop.proxy_detail.loopback_detail"))
          }

          if !connectedApps.isEmpty {
            Section {
              ForEach(connectedApps) { app in
                NavigationLink(value: DesignRouteID.app(app.id)) {
                  Label {
                    Text(app.name)
                  } icon: {
                    Image(systemName: app.symbol)
                      .foregroundStyle(.secondary)
                  }
                }
              }
            } header: {
              Text(model.localized("desktop.proxy_detail.client_apps"))
            } footer: {
              Text(model.localized("desktop.proxy_detail.client_apps_detail"))
            }
          }
        }
      } else {
        DesignEmptyState(
          title: model.localized("desktop.proxy_detail.unavailable"),
          message: model.localized("desktop.proxy_detail.unavailable_detail"),
          symbol: "server.rack"
        )
      }
    }
    .navigationTitle(proxy?.name ?? model.localized("desktop.nav.proxies"))
    .designConfirmation($confirmation, model: model)
    .onChange(of: model.copiedKey) { _, copied in
      guard copied?.id == proxyID else { return }
      didCopyApiKey = true
      DispatchQueue.main.asyncAfter(deadline: .now() + 1.4) {
        didCopyApiKey = false
      }
    }
  }

  private func requestStop() {
    confirmation = DesignConfirmation(
      id: "stop-proxy",
      title: model.localized("desktop.proxy_detail.stop_title", replacing: ["name": proxy?.name ?? model.localized("desktop.proxy_detail.this_proxy")]),
      message: model.localized("desktop.proxy_detail.stop_message"),
      action: .confirm(model.localized("desktop.proxy_detail.stop_proxy")) { model.setProxyEnabled(id: proxyID, enabled: false) }
    )
  }

  private func requestRotate() {
    confirmation = DesignConfirmation(
      id: "rotate-proxy-key",
      title: model.localized("desktop.proxy_detail.rotate_title", replacing: ["name": proxy?.name ?? model.localized("desktop.proxy_detail.this_proxy")]),
      message: model.localized("desktop.proxy_detail.rotate_message"),
      action: .confirm(model.localized("desktop.common.rotate_key")) { model.rotateProxyKey(id: proxyID) }
    )
  }

  private var connectedApps: [DesignApp] {
    guard let proxy else { return [] }
    return model.apps.filter { app in
      guard let route = app.routeOptions.first(where: { $0.id == app.selectedRouteID }) else { return false }
      guard route.kind != .native else { return false }
      return app.id == proxy.provider || route.id.localizedCaseInsensitiveContains(proxy.provider)
    }
  }

  private var servingAccountDisplay: String {
    guard let proxy else { return "" }
    let cleanDetail = proxy.detail.trimmingCharacters(in: .whitespacesAndNewlines)
    var accountName = cleanDetail
    if let range = cleanDetail.range(of: " · ") {
      accountName = String(cleanDetail[..<range.lowerBound]).trimmingCharacters(in: .whitespacesAndNewlines)
    }
    if let match = model.accounts.first(where: {
      $0.name.localizedCaseInsensitiveCompare(accountName) == .orderedSame
        || proxy.id.localizedCaseInsensitiveContains($0.id)
    }) {
      let identity = accountIdentityLine(provider: match.provider, detail: match.detail)
      return identity.isEmpty ? match.name : "\(match.name) (\(identity))"
    }
    return accountName.isEmpty ? proxy.detail : accountName
  }

  private func proxyActions(for proxy: DesignProxy) -> some View {
    DesignPaneActions {
      DesignSheetButton(
        title: model.localized("desktop.proxy_detail.restart_proxy"),
        enabled: !model.isBusy
          && canRestartProxy(isRunning: proxy.status == .running, status: proxy.status)
          && model.serviceOperations[proxy.id] == nil,
        identifier: "proxies.inspector.restart"
      ) { model.restartProxy(id: proxy.id) }
    }
  }

  @ViewBuilder
  private func proxyLifecycleAction(_ proxy: DesignProxy) -> some View {
    let busyRow = model.serviceOperations[proxy.id] != nil
    let busy = model.isBusy || busyRow
    Group {
      if proxy.status == .running {
        Button(role: .destructive) {
          requestStop()
        } label: {
          if busyRow { ProgressView().controlSize(.small) } else { Text(model.localized("desktop.common.stop")) }
        }
        .disabled(busy)
        .help(model.localized("desktop.proxy_detail.stop_help"))
        .accessibilityLabel(model.localized(busyRow ? "desktop.proxy_detail.stopping" : "desktop.proxy_detail.stop_named", replacing: ["name": proxy.name]))
      } else {
        Button {
          model.setProxyEnabled(id: proxy.id, enabled: true)
        } label: {
          if busyRow { ProgressView().controlSize(.small) } else { Text(model.localized("desktop.common.start")) }
        }
        .disabled(busy)
        .help(model.localized("desktop.proxy_detail.start_help"))
        .accessibilityLabel(model.localized(busyRow ? "desktop.proxy_detail.starting" : "desktop.proxy_detail.start_named", replacing: ["name": proxy.name]))
      }
    }
    .buttonStyle(.bordered)
    .controlSize(.small)
    .accessibilityIdentifier("proxies.inspector.lifecycle")
  }

  private var providerName: String {
    guard let proxy else { return model.localized("desktop.nav.proxies") }
    return nativeProviderName(proxy.provider)
  }

  private var purpose: String {
    guard let proxy else { return model.localized("desktop.proxy_detail.local_compatibility_service") }
    return model.localized("desktop.proxy_detail.compatibility", replacing: ["provider": nativeProviderName(proxy.provider)])
  }

  private func copyAddress() {
    guard let proxy else { return }
    let address = "http://127.0.0.1:\(proxy.port)"
    let copied = (NSPasteboard.general.clearContents() != 0)
      && NSPasteboard.general.setString(address, forType: .string)
    guard copied else {
      model.announceOnly(model.localized("desktop.proxy_detail.copy_address_failed", replacing: ["name": proxy.name]))
      return
    }
    model.announceOnly(model.localized("desktop.proxy_detail.copy_address_success", replacing: ["name": proxy.name]))
    didCopy = true
    DispatchQueue.main.asyncAfter(deadline: .now() + 1.4) {
      didCopy = false
    }
  }

}
