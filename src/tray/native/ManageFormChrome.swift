import AppKit
import Foundation
import SwiftUI

// Module: ManageFormChrome.swift — form headers, pickers, empty states

struct NativeFormHeader: View {
  let title: String
  let detail: String
  let onBack: () -> Void

  var body: some View {
    HStack(spacing: 10) {
      Button(action: onBack) {
        Image(systemName: "chevron.left")
          .frame(width: 24, height: 24)
          .contentShape(Rectangle())
      }
      .buttonStyle(AnyPickPlainButtonStyle(cornerRadius: 6))
      .help("Back to Accounts")
      .accessibilityLabel("Back to Accounts")
      VStack(alignment: .leading, spacing: 2) {
        Text(title)
          .font(.headline)
        Text(detail)
          .font(.caption)
          .foregroundStyle(.secondary)
      }
      Spacer()
    }
  }
}

struct NativeFormField<Content: View>: View {
  let label: String
  var required: Bool = false
  var hint: String? = nil
  @ViewBuilder let content: () -> Content

  var body: some View {
    VStack(alignment: .leading, spacing: 6) {
      HStack(spacing: 2) {
        Text(label)
          .font(.caption.weight(.medium))
          .foregroundStyle(.secondary)
        if required {
          Text("*")
            .font(.caption.weight(.bold))
            .foregroundStyle(.red.opacity(0.85))
            .accessibilityLabel("required")
        }
      }
      content()
        .padding(.horizontal, 10)
        .padding(.vertical, 8)
        .frame(maxWidth: .infinity, alignment: .leading)
        .background(
          RoundedRectangle(cornerRadius: 8, style: .continuous)
            .fill(Color.primary.opacity(0.045))
        )
        .overlay(
          RoundedRectangle(cornerRadius: 8, style: .continuous)
            .stroke(nativeStroke.opacity(0.7), lineWidth: 0.5)
        )
      if let hint, !hint.isEmpty {
        Text(hint)
          .font(.caption2)
          .foregroundStyle(.tertiary)
          .fixedSize(horizontal: false, vertical: true)
      }
    }
  }
}

struct NativeReadOnlyProvider: View {
  let id: String
  let text: String

  var body: some View {
    HStack(spacing: 10) {
      NativeProviderBadge(id: id, size: 28)
      Text(text)
        .font(.callout.weight(.medium))
        .lineLimit(1)
      Spacer()
    }
    .padding(10)
    .background(
      RoundedRectangle(cornerRadius: 8, style: .continuous)
        .fill(Color.primary.opacity(0.04))
    )
  }
}

struct NativeAccountProviderPicker: View {
  let providers: [AccountProviderSnapshot]
  @Binding var selectedId: String?
  @State private var showing = false
  @State private var search = ""

  var body: some View {
    Button { showing.toggle() } label: {
      HStack(spacing: 8) {
        if let selected { NativeProviderBadge(id: selected.id, size: 24) }
        Text(selected?.label ?? "Choose a provider")
        Spacer()
        Image(systemName: "chevron.down")
          .font(.caption2.weight(.bold))
          .foregroundStyle(.secondary)
      }
      .contentShape(Rectangle())
    }
    .buttonStyle(AnyPickPlainButtonStyle(cornerRadius: 8))
    .popover(isPresented: $showing, arrowEdge: .bottom) {
      NativeProviderSearch(search: $search, placeholder: "Search providers") {
        ForEach(filtered) { provider in
          Button {
            selectedId = provider.id
            showing = false
          } label: {
            HStack(spacing: 10) {
              NativeProviderBadge(id: provider.providerId, size: 26)
              VStack(alignment: .leading, spacing: 2) {
                Text(provider.label)
                  .font(.callout.weight(.medium))
                Text(provider.installed ? provider.detail : "Not signed in")
                  .font(.caption)
                  .foregroundStyle(.secondary)
              }
              Spacer()
              if selectedId == provider.id {
                Image(systemName: "checkmark")
                  .font(.caption.weight(.bold))
                  .foregroundStyle(Color.accentColor)
              }
            }
          }
          .buttonStyle(AnyPickPlainButtonStyle(cornerRadius: 8))
          .padding(.vertical, 4)
          .disabled(!provider.installed)
        }
      }
    }
  }

  private var selected: AccountProviderSnapshot? { providers.first { $0.id == selectedId } }
  private var filtered: [AccountProviderSnapshot] {
    let query = search.trimmingCharacters(in: .whitespacesAndNewlines)
    let installed = providers.filter(\.installed)
    guard !query.isEmpty else { return installed }
    return installed.filter {
      $0.label.localizedCaseInsensitiveContains(query) ||
        $0.detail.localizedCaseInsensitiveContains(query) ||
        $0.providerId.localizedCaseInsensitiveContains(query)
    }
  }
}

struct NativeGatewayProviderPicker: View {
  let providers: [GatewayProviderSnapshot]
  @Binding var selectedId: String?
  @State private var showing = false
  @State private var search = ""

  var body: some View {
    Button { showing.toggle() } label: {
      HStack(spacing: 8) {
        if let selected { NativeProviderBadge(id: selected.id, size: 24) }
        VStack(alignment: .leading, spacing: 1) {
          Text(selected?.label ?? "Choose a provider")
          if let selected {
            Text(selected.kind == "account-api-key" ? "API key account" : "Gateway")
              .font(.caption2)
              .foregroundStyle(.secondary)
          }
        }
        Spacer()
        Image(systemName: "chevron.down")
          .font(.caption2.weight(.bold))
          .foregroundStyle(.secondary)
      }
      .contentShape(Rectangle())
    }
    .buttonStyle(AnyPickPlainButtonStyle(cornerRadius: 8))
    .popover(isPresented: $showing, arrowEdge: .bottom) {
      NativeProviderSearch(search: $search, placeholder: "Search providers") {
        if !apiKeyAccounts.isEmpty {
          Text("API key accounts")
            .font(.caption.weight(.semibold))
            .foregroundStyle(.secondary)
            .padding(.top, 4)
          ForEach(apiKeyAccounts) { provider in
            providerRow(provider)
          }
        }
        if !gateways.isEmpty {
          Text("Gateways")
            .font(.caption.weight(.semibold))
            .foregroundStyle(.secondary)
            .padding(.top, apiKeyAccounts.isEmpty ? 4 : 10)
          ForEach(gateways) { provider in
            providerRow(provider)
          }
        }
      }
    }
  }

  @ViewBuilder
  private func providerRow(_ provider: GatewayProviderSnapshot) -> some View {
    Button {
      selectedId = provider.id
      showing = false
    } label: {
      HStack(spacing: 10) {
        NativeProviderBadge(id: provider.id, size: 26)
        VStack(alignment: .leading, spacing: 2) {
          Text(provider.label)
            .font(.callout.weight(.medium))
          Text(provider.detail)
            .font(.caption)
            .foregroundStyle(.secondary)
        }
        Spacer()
        if selectedId == provider.id {
          Image(systemName: "checkmark")
            .font(.caption.weight(.bold))
            .foregroundStyle(Color.accentColor)
        }
      }
    }
    .buttonStyle(AnyPickPlainButtonStyle(cornerRadius: 8))
    .padding(.vertical, 4)
  }

  private var selected: GatewayProviderSnapshot? { providers.first { $0.id == selectedId } }
  private var filtered: [GatewayProviderSnapshot] {
    let query = search.trimmingCharacters(in: .whitespacesAndNewlines)
    guard !query.isEmpty else { return providers }
    return providers.filter {
      $0.label.localizedCaseInsensitiveContains(query) ||
        $0.detail.localizedCaseInsensitiveContains(query) ||
        $0.id.localizedCaseInsensitiveContains(query)
    }
  }
  private var apiKeyAccounts: [GatewayProviderSnapshot] {
    filtered.filter { $0.kind == "account-api-key" }
  }
  private var gateways: [GatewayProviderSnapshot] {
    filtered.filter { $0.kind != "account-api-key" }
  }
}

struct NativeProviderSearch<Content: View>: View {
  @Binding var search: String
  let placeholder: String
  @ViewBuilder let content: () -> Content

  var body: some View {
    VStack(alignment: .leading, spacing: 10) {
      HStack(spacing: 6) {
        Image(systemName: "magnifyingglass")
          .foregroundStyle(.secondary)
        TextField(placeholder, text: $search)
          .textFieldStyle(.plain)
      }
      .padding(8)
      .background(
        RoundedRectangle(cornerRadius: 8, style: .continuous)
          .fill(Color.primary.opacity(0.05))
      )
      content()
    }
    .padding(12)
    .frame(width: 320)
  }
}

struct NativeManagerEmpty: View {
  let symbol: String
  let title: String
  let detail: String

  var body: some View {
    VStack(spacing: 8) {
      Image(systemName: symbol)
        .font(.title2)
        .foregroundStyle(.secondary)
      Text(title)
        .font(.callout.weight(.semibold))
      Text(detail)
        .font(.caption)
        .foregroundStyle(.secondary)
        .multilineTextAlignment(.center)
    }
    .frame(maxWidth: .infinity)
    .padding(.vertical, 28)
    .padding(.horizontal, 20)
  }
}

struct NativeFormUnavailable: View {
  let symbol: String
  let title: String
  let detail: String

  var body: some View {
    HStack(spacing: 10) {
      Image(systemName: symbol)
        .font(.body.weight(.medium))
        .foregroundStyle(anypickAmber)
        .frame(width: 28, height: 28)
        .background(
          RoundedRectangle(cornerRadius: 7, style: .continuous)
            .fill(anypickAmber.opacity(0.1))
        )
      VStack(alignment: .leading, spacing: 2) {
        Text(title)
          .font(.callout.weight(.semibold))
        Text(detail)
          .font(.caption)
          .foregroundStyle(.secondary)
      }
      Spacer()
    }
    .padding(12)
    .background(
      RoundedRectangle(cornerRadius: 8, style: .continuous)
        .fill(Color.primary.opacity(0.04))
    )
  }
}
