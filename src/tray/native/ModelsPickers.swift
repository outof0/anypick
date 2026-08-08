import AppKit
import Foundation
import SwiftUI

// Module: ModelsPickers.swift — model value pickers

// MARK: - Model value picker

struct NativeRoleModelPicker: View {
  let options: [ClientModelOptionSnapshot]
  @Binding var selection: String
  let allowInherit: Bool
  let defaultModel: String
  /// Current value shown on the pop-up face (HIG), not a verb.
  var title: String = "Choose"
  var editable: Bool = true
  @State private var showing = false

  var body: some View {
    Button {
      showing.toggle()
    } label: {
      HStack(spacing: 4) {
        Text(title)
          .font(.caption.weight(.medium))
          .lineLimit(1)
        Image(systemName: "chevron.up.chevron.down")
          .font(.system(size: 8, weight: .semibold))
          .foregroundStyle(.secondary)
      }
      .padding(.horizontal, 8)
      .padding(.vertical, 4)
      .background(
        RoundedRectangle(cornerRadius: 6, style: .continuous)
          .fill(nativeControlFill)
      )
      .overlay(
        RoundedRectangle(cornerRadius: 6, style: .continuous)
          .stroke(nativeStroke.opacity(0.8), lineWidth: 0.5)
      )
    }
    .buttonStyle(AnyPickPlainButtonStyle(cornerRadius: 6, drawsFill: false))
    .disabled(!editable || options.isEmpty)
    .help("Choose model")
    .accessibilityLabel("Choose model")
    .popover(isPresented: $showing, arrowEdge: .bottom) {
      NativeModelChoicePopover(
        options: options,
        selection: $selection,
        allowInherit: allowInherit,
        defaultModel: defaultModel,
        showing: $showing
      )
    }
  }
}
struct NativeModelChoicePopover: View {
  let options: [ClientModelOptionSnapshot]
  @Binding var selection: String
  let allowInherit: Bool
  let defaultModel: String
  @Binding var showing: Bool
  @State private var search = ""
  @State private var selectedProviderId: String?
  @FocusState private var searchFocused: Bool

  private var query: String { search.trimmingCharacters(in: .whitespacesAndNewlines) }
  private var current: ClientModelOptionSnapshot? { options.first { $0.modelId == selection } }
  private var providerIds: [String] {
    Array(Set(options.map(\.providerId))).sorted {
      nativeProviderName($0).localizedCaseInsensitiveCompare(nativeProviderName($1)) == .orderedAscending
    }
  }
  private var matchingOptions: [ClientModelOptionSnapshot] {
    guard !query.isEmpty else { return [] }
    return options.filter { option in
      option.modelId.localizedCaseInsensitiveContains(query) ||
        option.sourceLabel.localizedCaseInsensitiveContains(query) ||
        nativeProviderName(option.providerId).localizedCaseInsensitiveContains(query)
    }
    .sorted { $0.modelId.localizedCaseInsensitiveCompare($1.modelId) == .orderedAscending }
  }

  var body: some View {
    VStack(alignment: .leading, spacing: 8) {
      HStack(spacing: 6) {
        Image(systemName: "magnifyingglass").foregroundStyle(.secondary)
        TextField("Search models", text: $search)
          .textFieldStyle(.plain)
          .focused($searchFocused)
        if !search.isEmpty {
          Button { search = "" } label: {
            Image(systemName: "xmark.circle.fill").foregroundStyle(.secondary)
          }
          .buttonStyle(AnyPickPlainButtonStyle(cornerRadius: 6))
          .help("Clear search")
        }
      }
      .padding(.horizontal, 10)
      .padding(.vertical, 8)
      .background(
        RoundedRectangle(cornerRadius: 8, style: .continuous)
          .fill(nativeChipFill)
      )
      .overlay(
        RoundedRectangle(cornerRadius: 8, style: .continuous)
          .stroke(nativeStroke.opacity(0.7), lineWidth: 0.5)
      )

      if query.isEmpty, let providerId = selectedProviderId {
        HStack(spacing: 7) {
          Button { selectedProviderId = nil } label: {
            Image(systemName: "chevron.left").font(.caption.weight(.semibold))
          }
          .buttonStyle(AnyPickPlainButtonStyle(cornerRadius: 6))
          .foregroundStyle(Color.accentColor)
          NativeProviderBadge(id: providerId, size: 22)
          Text(nativeProviderName(providerId)).font(.callout.weight(.semibold))
          Spacer()
          Text("\(providerOptions(providerId).count) models")
            .font(.caption).foregroundStyle(.secondary)
        }
      }

      ScrollView(showsIndicators: false) {
        LazyVStack(alignment: .leading, spacing: 4) {
          if !query.isEmpty {
            if matchingOptions.isEmpty {
              emptyMessage("No matching models")
            } else {
              pickerLabel("Results")
              ForEach(Array(matchingOptions.prefix(20))) { option in optionButton(option) }
              overflowHint(total: matchingOptions.count, shown: 20)
            }
          } else if let providerId = selectedProviderId {
            let providerModels = providerOptions(providerId).filter { $0.actionId != current?.actionId }
            ForEach(Array(providerModels.prefix(12))) { option in optionButton(option) }
            if providerModels.count > 12 {
              Text("Search to find the remaining \(providerModels.count - 12) models.")
                .font(.caption).foregroundStyle(.secondary).padding(8)
            }
          } else {
            rootResults
          }
        }
        .frame(maxWidth: .infinity, alignment: .leading)
      }
      .frame(maxHeight: 330)

      }
    .padding(10)
    .frame(width: 380)
    .onAppear { searchFocused = true }
    .onChange(of: search) { _, value in
      if !value.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty {
        selectedProviderId = nil
      }
    }
  }

  @ViewBuilder private var rootResults: some View {
    if allowInherit {
      pickerLabel("Inheritance")
      inheritButton
    }
    if let current {
      pickerLabel("Current")
      optionButton(current)
    }
    if !providerIds.isEmpty {
      pickerLabel("Models by provider")
      ForEach(providerIds, id: \.self) { providerId in providerButton(providerId) }
    }
    if options.isEmpty { emptyMessage("No models are available") }
  }

  private var inheritButton: some View {
    Button {
      selection = ""
      showing = false
    } label: {
      HStack(spacing: 9) {
        Image(systemName: selection.isEmpty ? "checkmark" : "").frame(width: 13)
        Image(systemName: "arrow.turn.down.right")
          .font(.caption.weight(.medium)).foregroundStyle(.secondary)
          .frame(width: 25, height: 25)
        VStack(alignment: .leading, spacing: 1) {
          Text("Use Default").font(.callout.weight(.medium))
          Text(defaultModel.isEmpty ? "Choose Default first" : defaultModel)
            .font(.caption).foregroundStyle(.secondary).lineLimit(1)
        }
        Spacer()
      }
      .contentShape(Rectangle())
    }
    .buttonStyle(AnyPickPlainButtonStyle(cornerRadius: 8))
    .padding(.vertical, 4)
    .disabled(selection.isEmpty)
  }

  private func providerOptions(_ providerId: String) -> [ClientModelOptionSnapshot] {
    options.filter { $0.providerId == providerId }
      .sorted { $0.modelId.localizedCaseInsensitiveCompare($1.modelId) == .orderedAscending }
  }

  private func providerButton(_ providerId: String) -> some View {
    let models = providerOptions(providerId)
    let sources = Set(models.map(\.sourceLabel)).count
    return Button { selectedProviderId = providerId } label: {
      HStack(spacing: 9) {
        NativeProviderBadge(id: providerId, size: 27)
        VStack(alignment: .leading, spacing: 1) {
          Text(nativeProviderName(providerId)).font(.callout.weight(.medium))
          Text("\(models.count) models\(sources > 1 ? " · \(sources) accounts" : "")")
            .font(.caption).foregroundStyle(.secondary)
        }
        Spacer()
        Image(systemName: "chevron.right")
          .font(.caption2.weight(.semibold)).foregroundStyle(.tertiary)
      }
      .contentShape(Rectangle())
      .padding(.horizontal, 7)
      .padding(.vertical, 6)
    }
    .buttonStyle(AnyPickPlainButtonStyle(cornerRadius: 8))
  }

  private func optionButton(_ option: ClientModelOptionSnapshot) -> some View {
    Button {
      selection = option.modelId
      showing = false
    } label: {
      HStack(spacing: 9) {
        Image(systemName: option.modelId == selection ? "checkmark" : "")
          .font(.callout.weight(.bold))
          .foregroundStyle(Color.accentColor)
          .frame(width: 13)
        NativeProviderBadge(id: option.providerId, size: 25)
        VStack(alignment: .leading, spacing: 1) {
          Text(option.modelId).font(.callout.weight(.medium)).lineLimit(1)
          Text(option.sourceLabel).font(.caption).foregroundStyle(.secondary).lineLimit(1)
        }
        Spacer()
      }
      .contentShape(Rectangle())
    }
    .buttonStyle(AnyPickPlainButtonStyle(cornerRadius: 8))
    .padding(.vertical, 4)
    .disabled(option.modelId == selection)
  }

  private func pickerLabel(_ title: String) -> some View {
    Text(title.uppercased())
      .font(.caption2.weight(.semibold))
      .foregroundStyle(.secondary)
      .tracking(0.3)
      .padding(.horizontal, 8)
      .padding(.top, 6)
      .padding(.bottom, 1)
  }

  @ViewBuilder private func overflowHint(total: Int, shown: Int) -> some View {
    if total > shown {
      Text("Search to find \(total - shown) more.")
        .font(.caption).foregroundStyle(.secondary).padding(.horizontal, 8)
    }
  }

  private func emptyMessage(_ text: String) -> some View {
    Text(text).foregroundStyle(.secondary).frame(maxWidth: .infinity)
      .padding(.vertical, 20)
  }
}
