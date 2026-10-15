import SwiftUI

struct ConnectGatewaySheet: View {
  @ObservedObject var model: MacOSDesignModel
  let gatewayID: String
  @Environment(\.dismiss) private var dismiss
  @State private var selectedAppIDs = Set<String>()

  private var gateway: DesignAccount? {
    model.accounts.first { $0.id == gatewayID && $0.kind == .gateway }
  }

  private var compatibleApps: [DesignApp] {
    guard let gateway else { return [] }
    return model.appsCompatible(with: gateway)
  }

  var body: some View {
    DesignSheetHost(
      model: model,
      title: gateway.map { model.localized("desktop.gateway.connect_title", replacing: ["name": $0.name]) } ?? model.localized("desktop.gateway.connect_api_gateway"),
      width: 440,
      primaryTitle: model.localized("desktop.common.connect"),
      primaryDisabled: model.isBusy || compatibleApps.isEmpty,
      primaryIdentifier: "gateway-connect.save",
      onCancel: { dismiss() },
      onPrimary: connect
    ) {
      Form {
        if compatibleApps.isEmpty {
          Section {
            Text(model.localized("desktop.gateway.compatible_clients"))
              .foregroundStyle(.secondary)
          }
        } else {
          Section {
            ForEach(compatibleApps) { app in
              Toggle(isOn: binding(for: app.id)) {
                Label {
                  VStack(alignment: .leading, spacing: 2) {
                    Text(app.name)
                    Text(usingDetail(app))
                      .foregroundStyle(.secondary)
                  }
                } icon: {
                  DesignProviderIcon(provider: app.id, fallbackSymbol: app.symbol, size: 16)
                }
              }
              .accessibilityIdentifier("gateway-connect.app.\(app.id)")
            }
          } header: {
            Text(model.localized("desktop.nav.apps"))
          } footer: {
            Text(model.localized("desktop.gateway.choose_apps"))
          }
        }
      }
      .onAppear(perform: hydrateSelection)
    }
  }

  private func binding(for appID: String) -> Binding<Bool> {
    Binding(
      get: { selectedAppIDs.contains(appID) },
      set: { isOn in
        if isOn { selectedAppIDs.insert(appID) } else { selectedAppIDs.remove(appID) }
      }
    )
  }

  private func usingDetail(_ app: DesignApp) -> String {
    guard let gateway, let route = model.gatewayRoute(in: app, matching: gateway) else {
      return app.detail
    }
    return app.selectedRouteID == route.id ? model.localized("desktop.gateway.uses_gateway") : app.detail
  }

  private func hydrateSelection() {
    guard let gateway else { return }
    selectedAppIDs = Set(
      compatibleApps.compactMap { app in
        guard let route = model.gatewayRoute(in: app, matching: gateway) else { return nil }
        return app.selectedRouteID == route.id ? app.id : nil
      }
    )
  }

  private func connect() {
    model.connectGateway(id: gatewayID, appIDs: selectedAppIDs)
    dismiss()
  }
}
