import AppKit
import Foundation
import SwiftUI

// Module: ManagePanel.swift — manage list shell and rows

struct NativeManagePanel: View {
  @ObservedObject var store: TrayStore
  @State private var page = NativeManagePage.list
  @State private var selectedAccountId: String?
  @State private var selectedGatewayId: String?

  var body: some View {
    Group {
      switch page {
      case .list:
        NativeManageList(
          store: store,
          addAccount: { page = .addAccount },
          editAccount: {
            selectedAccountId = $0.id
            page = .editAccount
          },
          addGateway: { page = .addGateway },
          editGateway: {
            selectedGatewayId = $0.id
            page = .editGateway
          }
        )
      case .addAccount:
        NativeAccountForm(store: store, accountId: nil, onBack: showList)
      case .editAccount:
        NativeAccountForm(store: store, accountId: selectedAccountId, onBack: showList)
      case .addGateway:
        NativeGatewayForm(store: store, gatewayId: nil, onBack: showList)
      case .editGateway:
        NativeGatewayForm(store: store, gatewayId: selectedGatewayId, onBack: showList)
      }
    }
    .id(page)
    .transition(TrayMotion.panelTransition)
    .animation(TrayMotion.standard, value: page)
  }

  private func showList() {
    selectedAccountId = nil
    selectedGatewayId = nil
    page = .list
  }
}
struct NativeManageList: View {
  @ObservedObject var store: TrayStore
  let addAccount: () -> Void
  let editAccount: (ManagedAccountSnapshot) -> Void
  let addGateway: () -> Void
  let editGateway: (GatewaySnapshot) -> Void
  @State private var search = ""
  @State private var providerFilter = "all"

  private var providerIds: [String] {
    let ids = store.accounts.map(\.providerId) + store.gateways.map(\.providerId)
    return Array(Set(ids.map(nativeProviderFamily)))
      .sorted {
        nativeProviderRank($0) == nativeProviderRank($1)
          ? nativeProviderName($0) < nativeProviderName($1)
          : nativeProviderRank($0) < nativeProviderRank($1)
      }
  }

  private var filterLabel: String {
    providerFilter == "all" ? "All providers" : nativeProviderName(providerFilter)
  }

  private var accounts: [ManagedAccountSnapshot] {
    let query = search.trimmingCharacters(in: .whitespacesAndNewlines)
    return store.accounts.filter {
      let matchesProvider = providerFilter == "all"
        || nativeProviderFamily($0.providerId) == providerFilter
      let matchesQuery = query.isEmpty ||
        $0.label.localizedCaseInsensitiveContains(query) ||
        $0.detail.localizedCaseInsensitiveContains(query) ||
        $0.providerId.localizedCaseInsensitiveContains(query)
      return matchesProvider && matchesQuery
    }
  }

  private var gateways: [GatewaySnapshot] {
    let query = search.trimmingCharacters(in: .whitespacesAndNewlines)
    return store.gateways.filter {
      let matchesProvider = providerFilter == "all"
        || nativeProviderFamily($0.providerId) == providerFilter
      let matchesQuery = query.isEmpty ||
        $0.name.localizedCaseInsensitiveContains(query) ||
        $0.detail.localizedCaseInsensitiveContains(query) ||
        $0.providerId.localizedCaseInsensitiveContains(query)
      return matchesProvider && matchesQuery
    }
  }

  var body: some View {
    VStack(alignment: .leading, spacing: 16) {
      NativeSearchField(placeholder: "Search accounts and gateways", text: $search)

      if !providerIds.isEmpty {
        ScrollView(.horizontal, showsIndicators: false) {
          HStack(spacing: 6) {
            providerFilterButton(id: "all", label: "All")
            ForEach(providerIds, id: \.self) { providerId in
              providerFilterButton(id: providerId, label: nativeProviderName(providerId))
            }
          }
          .padding(.horizontal, 1)
        }
      }

      NativeSectionHeader(title: "Saved Accounts", detail: "Logins stored on this Mac", action: addAccount) {
        Text("Add")
      }
      VStack(spacing: 0) {
        if accounts.isEmpty {
          NativeManagerEmpty(
            symbol: "person.crop.circle.badge.plus",
            title: store.accounts.isEmpty ? "No saved accounts" : "No matching accounts",
            detail: emptyDetail(kind: "accounts")
          )
        } else {
          ForEach(Array(accounts.enumerated()), id: \.element.id) { index, account in
            NativeManagedAccountRow(account: account, store: store) { editAccount(account) }
            if index < accounts.count - 1 {
              Divider().padding(.leading, 54)
            }
          }
        }
      }
      .nativeGroup()

      NativeSectionHeader(
        title: "Gateways",
        detail: "For Claude Code and Codex",
        action: addGateway
      ) {
        Text("Add")
      }
      VStack(spacing: 0) {
        if gateways.isEmpty {
          NativeManagerEmpty(
            symbol: "network.badge.shield.half.filled",
            title: store.gateways.isEmpty ? "No gateways configured" : "No matching gateways",
            detail: emptyDetail(kind: "gateways")
          )
        } else {
          ForEach(Array(gateways.enumerated()), id: \.element.id) { index, gateway in
            NativeManagedGatewayRow(gateway: gateway, store: store) { editGateway(gateway) }
            if index < gateways.count - 1 {
              Divider().padding(.leading, 54)
            }
          }
        }
      }
      .nativeGroup()

      Label("Gateway secrets are stored in macOS Keychain.", systemImage: "lock.shield")
        .font(.caption)
        .foregroundStyle(.secondary)
        .padding(.horizontal, 4)
    }
    .onChange(of: providerIds) { _, ids in
      if providerFilter != "all" && !ids.contains(providerFilter) { providerFilter = "all" }
    }
  }

  private func providerFilterButton(id: String, label: String) -> some View {
    let selected = providerFilter == id
    return Button { providerFilter = id } label: {
      Text(label)
        .font(.caption.weight(selected ? .semibold : .medium))
        .padding(.horizontal, 11)
        .padding(.vertical, 6)
        .foregroundStyle(selected ? Color.white : Color.secondary)
        .background(
          Capsule().fill(selected ? Color.accentColor : Color.primary.opacity(0.06))
        )
    }
    .buttonStyle(AnyPickPlainButtonStyle(chrome: .capsule))
  }

  private func emptyDetail(kind: String) -> String {
    if !search.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty {
      return "Try another search or clear the current query."
    }
    if providerFilter != "all" {
      return "No \(kind) are saved for \(filterLabel). Choose another provider."
    }
    return kind == "accounts"
      ? "Add an account from a signed-in AI client or CLI login."
      : "Add a gateway for Claude Code or Codex."
  }
}

struct NativeManagedAccountRow: View {
  let account: ManagedAccountSnapshot
  @ObservedObject var store: TrayStore
  let edit: () -> Void
  @State private var confirmRemove = false

  var body: some View {
    HStack(spacing: 10) {
      NativeProviderBadge(id: account.providerId, size: 32)
      VStack(alignment: .leading, spacing: 2) {
        HStack(spacing: 6) {
          Text(account.label)
            .font(.callout.weight(.semibold))
            .lineLimit(1)
          if account.active {
            Text("Active")
              .font(.caption2.weight(.semibold))
              .foregroundStyle(anypickSuccess)
          }
        }
        Text(account.detail)
          .font(.caption)
          .foregroundStyle(.secondary)
          .lineLimit(1)
      }
      Spacer(minLength: 6)
      Button("Edit", action: edit)
        .buttonStyle(.bordered)
        .controlSize(.small)
        .disabled(store.busyRequestId != nil)
      Menu {
        Button("Refresh saved account") {
          store.mutate(
            operation: "account-refresh",
            name: account.name,
            providerId: account.providerId,
            activityLabel: "refreshing \(account.label)"
          )
        }
        .disabled(!account.canRefresh || store.busyRequestId != nil)
        Button("Save current login") {
          store.mutate(
            operation: "account-save",
            name: account.name,
            providerId: account.providerId,
            sourceId: account.sourceId,
            label: account.label,
            overwrite: true,
            activityLabel: "saving \(account.label)"
          )
        }
        .disabled(!account.active || store.busyRequestId != nil)
        Divider()
        Button("Remove…", role: .destructive) {
          confirmRemove = true
        }
        .disabled(store.busyRequestId != nil)
      } label: {
        TrayOverflowMenuLabel()
      }
      .trayMenuLabel()
      .anypickInteractive(highlight: true, cornerRadius: 7)
      .help("Account actions")
      .accessibilityLabel("Account actions for \(account.label)")
      .disabled(store.busyRequestId != nil)
    }
    .padding(12)
    .confirmationDialog(
      "Remove \(account.label)?",
      isPresented: $confirmRemove,
      titleVisibility: .visible
    ) {
      Button("Remove", role: .destructive) {
        store.mutate(
          operation: "account-remove",
          name: account.name,
          providerId: account.providerId,
          activityLabel: "removing \(account.label)"
        )
      }
      Button("Cancel", role: .cancel) {}
    } message: {
      Text("This removes the saved login from AnyPick. The live app login is not signed out.")
    }
  }
}

struct NativeManagedGatewayRow: View {
  let gateway: GatewaySnapshot
  @ObservedObject var store: TrayStore
  let edit: () -> Void
  @State private var confirmRemove = false

  var body: some View {
    HStack(spacing: 10) {
      NativeProviderBadge(id: gateway.providerId, size: 32)
      VStack(alignment: .leading, spacing: 2) {
        HStack(spacing: 6) {
          Text(gateway.name)
            .font(.callout.weight(.semibold))
            .lineLimit(1)
          Text(gateway.ready ? "Ready" : "Needs key")
            .font(.caption2.weight(.semibold))
            .foregroundStyle(gateway.ready ? anypickSuccess : anypickAmber)
        }
        Text(gateway.detail)
          .font(.caption)
          .foregroundStyle(.secondary)
          .lineLimit(1)
      }
      Spacer(minLength: 6)
      Button("Edit", action: edit)
        .buttonStyle(.bordered)
        .controlSize(.small)
        .disabled(store.busyRequestId != nil)
      Menu {
        Button("Refresh available models") {
          store.mutate(
            operation: "gateway-refresh",
            name: gateway.name,
            activityLabel: "refreshing \(gateway.name) models"
          )
        }
        .disabled(!gateway.ready || store.busyRequestId != nil)
        Divider()
        Button("Delete…", role: .destructive) {
          confirmRemove = true
        }
        .disabled(store.busyRequestId != nil)
      } label: {
        TrayOverflowMenuLabel()
      }
      .trayMenuLabel()
      .anypickInteractive(highlight: true, cornerRadius: 7)
      .help("Gateway actions")
      .accessibilityLabel("Gateway actions for \(gateway.name)")
      .disabled(store.busyRequestId != nil)
    }
    .padding(12)
    .confirmationDialog(
      "Delete gateway \(gateway.name)?",
      isPresented: $confirmRemove,
      titleVisibility: .visible
    ) {
      Button("Delete", role: .destructive) {
        store.mutate(
          operation: "gateway-remove",
          name: gateway.name,
          activityLabel: "removing gateway \(gateway.name)"
        )
      }
      Button("Cancel", role: .cancel) {}
    } message: {
      Text("Secrets stored for this gateway will be deleted. Apps using it must be switched to another route.")
    }
  }
}
