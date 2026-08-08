import AppKit
import Foundation
import SwiftUI

// Module: ModelsEditor.swift — client models editor and role rows

// MARK: - Editor

struct NativeClientModelsPanel: View {
  let config: ClientModelConfigSnapshot
  @ObservedObject var store: TrayStore
  let cancel: () -> Void
  @State private var selections: [String: String]
  @State private var submittedRequestId: String?
  @State private var listSearch = ""

  init(config: ClientModelConfigSnapshot, store: TrayStore, cancel: @escaping () -> Void) {
    self.config = config
    self.store = store
    self.cancel = cancel

    let defaultModel = config.modelRoles["default"] ?? config.defaultModel ?? ""
    var initial = config.modelRoles
    initial["default"] = defaultModel
    for role in config.roles where role.id != "default" {
      if initial[role.id] == defaultModel { initial[role.id] = "" }
    }
    _selections = State(initialValue: initial)
  }

  private var orderedRoles: [ClientModelRoleSnapshot] {
    if config.roles.contains(where: { $0.id == "default" }) {
      return config.roles
    }
    return [ClientModelRoleSnapshot(id: "default", label: "Default")] + config.roles
  }

  private var optionalRoles: [ClientModelRoleSnapshot] {
    orderedRoles.filter { $0.id != "default" }
  }

  private var defaultModel: String { selections["default"] ?? "" }

  private var roleActionIds: [String: String]? {
    guard let defaultOption = option(for: defaultModel) else { return nil }
    var result = ["default": defaultOption.actionId]
    for role in optionalRoles {
      let modelId = selections[role.id] ?? ""
      guard !modelId.isEmpty, modelId != defaultModel else { continue }
      guard let selected = option(for: modelId) else { return nil }
      result[role.id] = selected.actionId
    }
    return result
  }

  private var overrideCount: Int {
    optionalRoles.filter { role in
      let value = selections[role.id] ?? ""
      return !value.isEmpty && value != defaultModel
    }.count
  }

  /// Codex-style clients: one selectable model list, one default (not multi-role).
  private var isListStyle: Bool { optionalRoles.isEmpty }

  private var filteredOptions: [ClientModelOptionSnapshot] {
    let query = listSearch.trimmingCharacters(in: .whitespacesAndNewlines)
    guard !query.isEmpty else { return config.options }
    return config.options.filter {
      $0.modelId.localizedCaseInsensitiveContains(query)
        || $0.sourceLabel.localizedCaseInsensitiveContains(query)
        || nativeProviderName($0.providerId).localizedCaseInsensitiveContains(query)
    }
  }

  var body: some View {
    VStack(alignment: .leading, spacing: 12) {
      NativeSectionHeader(
        title: "\(anypickDisplayName(config.client)) Model Settings",
        detail: sectionDetail
      )

      if isListStyle {
        codexModelList
      } else {
        claudeRoleRows
      }

      if !config.editable {
        Label(
          config.unavailableReason ?? "This app cannot override models for the current route.",
          systemImage: "exclamationmark.triangle.fill"
        )
        .font(.caption)
        .foregroundStyle(anypickAmber)
        .padding(.horizontal, 2)
      } else if roleActionIds == nil {
        Label("Choose a model from the list before applying.", systemImage: "info.circle")
          .font(.caption)
          .foregroundStyle(anypickAmber)
          .padding(.horizontal, 2)
      }

      HStack(spacing: 8) {
        Text(
          isListStyle
            ? "\(config.options.count) in list · default: \(defaultModel.isEmpty ? "none" : defaultModel)"
            : "\(config.options.count) available"
        )
        .font(.caption)
        .foregroundStyle(.secondary)
        .lineLimit(1)
        Spacer()
        Button("Cancel", action: cancel)
          .buttonStyle(.bordered)
          .keyboardShortcut(.cancelAction)
        Button("Apply") {
          guard let roleActionIds else { return }
          submittedRequestId = store.applyModelRoles(
            clientId: config.clientId,
            roleActionIds: roleActionIds,
            label: anypickDisplayName(config.client)
          )
        }
        .buttonStyle(.borderedProminent)
        .keyboardShortcut(.defaultAction)
        .disabled(!config.editable || roleActionIds == nil || store.busyRequestId != nil)
        .help("Apply model settings for \(anypickDisplayName(config.client))")
      }
      .controlSize(.regular)
    }
    .onChange(of: store.lastResult?.requestId) { _, requestId in
      guard let submittedRequestId, requestId == submittedRequestId else { return }
      let succeeded = store.lastResult?.status == "success"
      self.submittedRequestId = nil
      if succeeded { cancel() }
    }
  }

  private var sectionDetail: String {
    let source = config.sourceLabel ?? "Current route"
    if isListStyle {
      return "\(source) · pick default from the list (Codex runs this model)"
    }
    if overrideCount == 0 {
      return "\(source) · optional roles inherit Default"
    }
    return "\(source) · \(overrideCount) override\(overrideCount == 1 ? "" : "s")"
  }

  @ViewBuilder
  private var claudeRoleRows: some View {
    VStack(spacing: 0) {
      ForEach(Array(orderedRoles.enumerated()), id: \.element.id) { index, role in
        roleRow(role)
        if index < orderedRoles.count - 1 {
          Divider().padding(.leading, TraySpacing.rowPadding)
        }
      }
    }
    .nativeGroup()
  }

  /// Scrollable model list: one checkmark = default. Full hub catalog, not GPT aliases.
  @ViewBuilder
  private var codexModelList: some View {
    VStack(alignment: .leading, spacing: 8) {
      HStack(spacing: 6) {
        Image(systemName: "magnifyingglass").foregroundStyle(.secondary)
        TextField("Search \(config.options.count) models", text: $listSearch)
          .textFieldStyle(.plain)
        if !listSearch.isEmpty {
          Button {
            listSearch = ""
          } label: {
            Image(systemName: "xmark.circle.fill").foregroundStyle(.secondary)
          }
          .buttonStyle(AnyPickPlainButtonStyle(cornerRadius: 6))
        }
      }
      .padding(.horizontal, 10)
      .padding(.vertical, 8)
      .background(
        RoundedRectangle(cornerRadius: 8, style: .continuous)
          .fill(nativeChipFill)
      )

      ScrollView {
        LazyVStack(spacing: 0) {
          ForEach(Array(filteredOptions.enumerated()), id: \.element.actionId) { index, option in
            Button {
              guard config.editable else { return }
              selections["default"] = option.modelId
            } label: {
              HStack(spacing: 10) {
                NativeProviderBadge(id: option.providerId, size: 22)
                VStack(alignment: .leading, spacing: 1) {
                  Text(option.modelId)
                    .font(.callout.weight(.medium))
                    .foregroundStyle(.primary)
                    .lineLimit(1)
                  Text(option.sourceLabel)
                    .font(.caption2)
                    .foregroundStyle(.secondary)
                    .lineLimit(1)
                }
                Spacer(minLength: 6)
                if option.modelId == defaultModel {
                  Image(systemName: "checkmark.circle.fill")
                    .foregroundStyle(Color.accentColor)
                }
              }
              .contentShape(Rectangle())
              .padding(.horizontal, TraySpacing.rowPadding)
              .padding(.vertical, 9)
            }
            .buttonStyle(AnyPickPlainButtonStyle(cornerRadius: 8))
            .disabled(!config.editable)
            if index < filteredOptions.count - 1 {
              Divider().padding(.leading, TraySpacing.dividerLeading)
            }
          }
          if filteredOptions.isEmpty {
            Text(config.options.isEmpty ? "No models on this route." : "No matches.")
              .font(.caption)
              .foregroundStyle(.secondary)
              .frame(maxWidth: .infinity, alignment: .leading)
              .padding(TraySpacing.rowPadding)
          }
        }
      }
      .frame(maxHeight: 360)
      .nativeGroup()
    }
  }

  @ViewBuilder
  private func roleRow(_ role: ClientModelRoleSnapshot) -> some View {
    if role.id == "default" {
      NativeModelRoleRow(
        role: role,
        status: "",
        options: config.options,
        selection: Binding(
          get: { defaultModel },
          set: { modelId in
            selections["default"] = modelId
            for optional in optionalRoles where selections[optional.id] == modelId {
              selections[optional.id] = ""
            }
          }
        ),
        allowInherit: false,
        defaultModel: defaultModel,
        editable: config.editable
      )
    } else {
      let value = selections[role.id] ?? ""
      let inherits = value.isEmpty || value == defaultModel
      NativeModelRoleRow(
        role: role,
        status: inherits ? "Same as Default" : "",
        options: config.options,
        selection: Binding(
          get: { selections[role.id] ?? "" },
          set: { selections[role.id] = $0 == defaultModel ? "" : $0 }
        ),
        allowInherit: true,
        defaultModel: defaultModel,
        editable: config.editable
      )
    }
  }

  private func option(for modelId: String) -> ClientModelOptionSnapshot? {
    guard !modelId.isEmpty else { return nil }
    return config.options.first { $0.modelId == modelId }
  }
}
// MARK: - Role row

struct NativeModelRoleRow: View {
  let role: ClientModelRoleSnapshot
  let status: String
  let options: [ClientModelOptionSnapshot]
  @Binding var selection: String
  let allowInherit: Bool
  let defaultModel: String
  var editable: Bool = true

  private var selectedOption: ClientModelOptionSnapshot? {
    options.first { $0.modelId == selection }
  }

  private var inheritsDefault: Bool {
    allowInherit && (selection.isEmpty || selection == defaultModel)
  }

  var body: some View {
    HStack(alignment: .center, spacing: 12) {
      VStack(alignment: .leading, spacing: 2) {
        Text(role.label)
          .font(.callout.weight(.semibold))
        if !status.isEmpty {
          Text(status)
            .font(.caption)
            .foregroundStyle(.secondary)
        }
      }
      .frame(minWidth: 72, idealWidth: 88, maxWidth: 110, alignment: .leading)

      Group {
        if inheritsDefault {
          valueStack(
            title: defaultModel.isEmpty ? "Choose Default first" : defaultModel,
            detail: defaultModel.isEmpty ? "Pick Default, then this role follows it" : "Same as Default",
            badge: nil,
            secondaryTitle: true
          )
        } else if let selectedOption {
          valueStack(
            title: selectedOption.modelId,
            detail: selectedOption.sourceLabel,
            badge: selectedOption.providerId,
            secondaryTitle: false
          )
        } else {
          valueStack(
            title: selection.isEmpty ? "No model selected" : selection,
            detail: selection.isEmpty ? "Choose a model to continue" : "Model not in current catalog",
            badge: nil,
            secondaryTitle: selection.isEmpty
          )
        }
      }
      .frame(maxWidth: .infinity, alignment: .leading)

      NativeRoleModelPicker(
        options: options,
        selection: $selection,
        allowInherit: allowInherit,
        defaultModel: defaultModel,
        title: popupTitle,
        editable: editable
      )
    }
    .padding(.horizontal, TraySpacing.rowPadding)
    .padding(.vertical, 10)
  }

  /// HIG pop-up face shows the current model value.
  private var popupTitle: String {
    if inheritsDefault {
      return defaultModel.isEmpty ? "Choose" : "Default"
    }
    if selection.isEmpty { return "Choose" }
    // Keep face short — full model id lives in the value stack.
    let parts = selection.split(separator: "/", maxSplits: 1).map(String.init)
    return parts.last ?? selection
  }

  @ViewBuilder
  private func valueStack(
    title: String,
    detail: String,
    badge: String?,
    secondaryTitle: Bool
  ) -> some View {
    HStack(spacing: 8) {
      if let badge {
        NativeProviderBadge(id: badge, size: 22)
      } else if inheritsDefault {
        Image(systemName: "arrow.turn.down.right")
          .font(.caption.weight(.semibold))
          .foregroundStyle(.secondary)
          .frame(width: 22, height: 22)
      }
      VStack(alignment: .leading, spacing: 1) {
        Text(title)
          .font(.callout.weight(.medium))
          .foregroundStyle(secondaryTitle ? Color.secondary : Color.primary)
          .lineLimit(1)
        Text(detail)
          .font(.caption2)
          .foregroundStyle(.tertiary)
          .lineLimit(1)
      }
    }
  }
}
