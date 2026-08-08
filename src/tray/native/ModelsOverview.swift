import AppKit
import Foundation
import SwiftUI

// Module: ModelsOverview.swift — app models overview

// MARK: - Overview

struct NativeAppModelsOverviewPanel: View {
  @ObservedObject var store: TrayStore
  let open: (String) -> Void

  var body: some View {
    VStack(alignment: .leading, spacing: 14) {
      NativeSectionHeader(
        title: "Model Settings",
        detail: "Codex: pick from the route list · Claude: default + role overrides"
      )

      if store.clientModelConfigs.isEmpty {
        NativeEmptyState(
          title: "No model settings available",
          systemImage: "slider.horizontal.3",
          description: "Connect Codex or Claude to a proxy or gateway first, then open Model Settings here."
        )
        .nativeGroup()
      } else {
        VStack(spacing: 0) {
          ForEach(Array(store.clientModelConfigs.enumerated()), id: \.element.id) { index, config in
            Button {
              open(config.clientId)
            } label: {
              HStack(spacing: 11) {
                NativeProviderBadge(id: config.clientId, size: 28)
                VStack(alignment: .leading, spacing: 2) {
                  Text(anypickDisplayName(config.client))
                    .font(.body.weight(.medium))
                  Text(modelSummary(config))
                    .font(.caption)
                    .foregroundStyle(config.editable ? .secondary : anypickAmber)
                    .lineLimit(1)
                }
                Spacer(minLength: 8)
                Image(systemName: "chevron.right")
                  .font(.caption.weight(.semibold))
                  .foregroundStyle(.tertiary)
              }
              .contentShape(Rectangle())
              .padding(.horizontal, TraySpacing.rowPadding)
              .padding(.vertical, 11)
            }
            .buttonStyle(AnyPickPlainButtonStyle(cornerRadius: 10))
            if index < store.clientModelConfigs.count - 1 {
              Divider().padding(.leading, TraySpacing.dividerLeading)
            }
          }
        }
        .nativeGroup()
      }
    }
  }

  private func modelSummary(_ config: ClientModelConfigSnapshot) -> String {
    if !config.editable { return config.unavailableReason ?? "Model settings unavailable" }
    let model = config.modelRoles["default"] ?? config.defaultModel
    guard let model, !model.isEmpty else { return "No default model selected" }
    let overrides = config.roles.filter { role in
      guard role.id != "default", let value = config.modelRoles[role.id] else { return false }
      return !value.isEmpty && value != model
    }.count
    let source = config.sourceLabel.map { "\($0) · " } ?? ""
    return overrides == 0
      ? "\(source)\(model)"
      : "\(source)\(model) · \(overrides) override\(overrides == 1 ? "" : "s")"
  }
}
