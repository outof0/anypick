import AppKit
import Foundation
import SwiftUI

// Module: ModelsRoutePickers.swift — source-first route pickers (same chrome as model pickers)
//
// Sections: Accounts · Proxies · Gateways (empty sections hidden).
// Open lands in the active section (no separate “Current” block).

struct NativeOnlyRouteRow: View {
  let sourceId: String
  let actions: [ActionSnapshot]
  let usage: UsageSnapshot?
  @ObservedObject var store: TrayStore

  private var selected: ActionSnapshot? { actions.first(where: \.selected) }

  var body: some View {
    HStack(alignment: .center, spacing: 12) {
      NativeProviderBadge(id: sourceId, size: 30)
      VStack(alignment: .leading, spacing: 2) {
        Text(sourceName)
          .font(.body.weight(.semibold))
          .lineLimit(1)
        Text(accountName(selected))
          .font(.caption)
          .foregroundStyle(.secondary)
          .lineLimit(1)
          .help(accountName(selected))
      }
      .frame(maxWidth: .infinity, alignment: .leading)
      TrayUsageMeter(usage: usage, compact: false, barWidth: 72)
        .frame(width: 96, alignment: .trailing)
      NativeRoutePicker(
        actions: actions,
        customRoleCount: 0,
        store: store
      )
      .frame(minWidth: 72, alignment: .trailing)
    }
    .padding(.horizontal, TraySpacing.rowPadding)
    .padding(.vertical, 10)
  }

  private var sourceName: String {
    actions.first?.label.components(separatedBy: " · ").first
      ?? anypickDisplayName(sourceId)
  }

  private func accountName(_ action: ActionSnapshot?) -> String {
    guard let action else { return "Not set" }
    if !action.label.isEmpty { return action.label }
    if let detail = action.detail, !detail.isEmpty { return detail }
    return "Not set"
  }
}

/// Pop-up face matches `NativeRoleModelPicker` (Codex model switch chrome).
/// Hidden when there is no alternate enabled source (nothing to switch to).
///
/// Pass `isPresented` from the row so chips “More…” reopen **this** popover
/// (MenuBarExtra forbids reliable nested popovers).
struct NativeRoutePicker: View {
  let actions: [ActionSnapshot]
  let customRoleCount: Int
  @ObservedObject var store: TrayStore
  var onConfigureModels: (() -> Void)? = nil
  var onOpenApp: (() -> Void)? = nil
  /// Optional external presentation (shared with chip “More…”).
  var isPresented: Binding<Bool>? = nil
  @State private var localShowing = false

  private var canSwitch: Bool { routeHasAlternates(actions) }

  private var showing: Binding<Bool> {
    isPresented ?? $localShowing
  }

  var body: some View {
    if canSwitch {
      Button {
        showing.wrappedValue.toggle()
      } label: {
        // Account identity already lives on the row — face is the verb only.
        HStack(spacing: 4) {
          Text("Switch")
            .font(.caption.weight(.medium))
            .lineLimit(1)
            .minimumScaleFactor(0.85)
          Image(systemName: "chevron.up.chevron.down")
            .font(.system(size: 8, weight: .semibold))
            .foregroundStyle(.secondary)
            .imageScale(.small)
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
      .disabled(store.busyRequestId != nil)
      .help("Switch source")
      .accessibilityLabel("Switch source")
      .accessibilityHint("Shows accounts, proxies, and gateways")
      .popover(isPresented: showing, arrowEdge: .bottom) {
        NativeRoutePickerPopover(
          actions: actions,
          customRoleCount: customRoleCount,
          store: store,
          showing: showing,
          onConfigureModels: onConfigureModels,
          onOpenApp: onOpenApp
        )
      }
      .onChange(of: store.busyRequestId) { _, requestId in
        // Close while a mutation runs so the popover cannot fight the busy lock.
        if requestId != nil { showing.wrappedValue = false }
      }
    }
  }
}

// MARK: - Sections

/// Switch groups: native logins · managed proxies (+ Hub) · gateway profiles.
private enum RoutePickerSection: String, CaseIterable, Identifiable {
  case accounts = "Accounts"
  case proxies = "Proxies"
  case gateways = "Gateways"
  var id: String { rawValue }

  var systemImage: String {
    switch self {
    case .accounts: return "person.crop.circle"
    case .proxies: return "point.3.connected.trianglepath.dotted"
    case .gateways: return "network"
    }
  }
}

struct NativeRoutePickerPopover: View {
  let actions: [ActionSnapshot]
  let customRoleCount: Int
  @ObservedObject var store: TrayStore
  @Binding var showing: Bool
  var onConfigureModels: (() -> Void)? = nil
  var onOpenApp: (() -> Void)? = nil
  @State private var search = ""
  /// nil = section list; non-nil = inside Accounts / Proxies / Gateways.
  @State private var section: RoutePickerSection?
  /// Proxies only: drill into a provider’s account/pool rows.
  @State private var selectedProviderId: String?
  @State private var pendingAction: ActionSnapshot?
  @State private var didOpenActivePath = false
  @FocusState private var searchFocused: Bool

  private var query: String { search.trimmingCharacters(in: .whitespacesAndNewlines) }
  private var current: ActionSnapshot? { actions.first(where: \.selected) }

  private var accountActions: [ActionSnapshot] {
    actions.filter { $0.routeKind == "direct-account" }
  }

  /// Managed proxies + pools (not Hub, not native, not gateway profiles).
  private var proxyAccountActions: [ActionSnapshot] {
    actions.filter { $0.routeKind == "account" || $0.routeKind == "pool" }
  }

  private var hubActions: [ActionSnapshot] {
    actions.filter { $0.routeKind == "hub" }
  }

  private var gatewayActions: [ActionSnapshot] {
    actions.filter { $0.routeKind == "gateway" || $0.routeKind == nil }
  }

  private var availableSections: [RoutePickerSection] {
    RoutePickerSection.allCases.filter { !items(in: $0).isEmpty }
  }

  private var matchingActions: [ActionSnapshot] {
    guard !query.isEmpty else { return [] }
    return actions.filter { action in
      action.label.localizedCaseInsensitiveContains(query) ||
        (action.detail?.localizedCaseInsensitiveContains(query) ?? false) ||
        (action.upstreamProviderId?.localizedCaseInsensitiveContains(query) ?? false) ||
        (action.upstreamSourceLabel?.localizedCaseInsensitiveContains(query) ?? false) ||
        (action.modelId?.localizedCaseInsensitiveContains(query) ?? false) ||
        nativeProviderName(providerKey(action)).localizedCaseInsensitiveContains(query) ||
        sectionTitle(for: action).localizedCaseInsensitiveContains(query)
    }
    .sorted {
      if $0.selected != $1.selected { return $0.selected }
      return routeActionTitle($0).localizedCaseInsensitiveCompare(routeActionTitle($1))
        == .orderedAscending
    }
  }

  var body: some View {
    VStack(alignment: .leading, spacing: 8) {
      if let pendingAction {
        routeResetConfirmation(pendingAction)
      } else {
        HStack(spacing: 6) {
          Image(systemName: "magnifyingglass").foregroundStyle(.secondary)
          TextField("Search sources", text: $search)
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

        if query.isEmpty {
          navigationHeader
        }

        ScrollView {
          LazyVStack(alignment: .leading, spacing: 4) {
            if !query.isEmpty {
              searchResults
            } else if let providerId = selectedProviderId, section == .proxies {
              providerResults(providerId)
            } else if let section {
              sectionResults(section)
            } else {
              rootSections
            }
          }
          .frame(maxWidth: .infinity, alignment: .leading)
        }
        .frame(maxHeight: 330)

        if onConfigureModels != nil || onOpenApp != nil {
          Divider().padding(.top, 2)
          HStack(spacing: 12) {
            if let onConfigureModels {
              Button("Model Settings…") {
                showing = false
                onConfigureModels()
              }
              .buttonStyle(.borderless)
              .font(.caption.weight(.medium))
              .foregroundStyle(Color.accentColor)
              .disabled(store.busyRequestId != nil)
            }
            if let onOpenApp {
              Button("Browse Apps…") {
                showing = false
                onOpenApp()
              }
              .buttonStyle(.borderless)
              .font(.caption.weight(.medium))
              .foregroundStyle(Color.accentColor)
            }
            Spacer(minLength: 0)
          }
          .padding(.horizontal, 4)
        }
      }
    }
    .padding(10)
    .frame(width: TraySpacing.quickPanelWidth)
    .frame(minHeight: 220, maxHeight: 400)
    // Keep search focused without trapping VoiceOver in a nested field forever.
    .onAppear {
      openActivePathIfNeeded()
      DispatchQueue.main.async {
        searchFocused = true
      }
    }
    .onChange(of: search) { _, value in
      if !value.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty {
        selectedProviderId = nil
      }
    }
  }

  // MARK: Navigation chrome

  @ViewBuilder private var navigationHeader: some View {
    if let providerId = selectedProviderId, section == .proxies {
      HStack(spacing: 7) {
        Button {
          selectedProviderId = nil
        } label: {
          Image(systemName: "chevron.left").font(.caption.weight(.semibold))
        }
        .buttonStyle(AnyPickPlainButtonStyle(cornerRadius: 6))
        .foregroundStyle(Color.accentColor)
        NativeProviderBadge(id: providerId, size: 22)
        Text(nativeProviderName(providerId)).font(.callout.weight(.semibold))
        Spacer()
        Text("\(providerProxySources(providerId).count)")
          .font(.caption).foregroundStyle(.secondary)
      }
    } else if let section {
      HStack(spacing: 7) {
        // Back to section list only when more than one group exists.
        if availableSections.count > 1 {
          Button {
            self.section = nil
            selectedProviderId = nil
          } label: {
            Image(systemName: "chevron.left").font(.caption.weight(.semibold))
          }
          .buttonStyle(AnyPickPlainButtonStyle(cornerRadius: 6))
          .foregroundStyle(Color.accentColor)
        }
        Image(systemName: section.systemImage)
          .font(.callout.weight(.semibold))
          .foregroundStyle(.secondary)
          .frame(width: 22, height: 22)
        Text(section.rawValue).font(.callout.weight(.semibold))
        Spacer()
        Text("\(items(in: section).count)")
          .font(.caption).foregroundStyle(.secondary)
      }
    }
  }

  // MARK: Root — Accounts / Proxies / Gateways

  @ViewBuilder private var rootSections: some View {
    if availableSections.isEmpty {
      emptyMessage("No sources are available")
    } else {
      pickerLabel("Switch source")
      ForEach(availableSections) { section in
        sectionButton(section)
      }
    }
  }

  private func sectionButton(_ section: RoutePickerSection) -> some View {
    let count = items(in: section).count
    let active = current.map { sectionFor($0) == section } ?? false
    return Button {
      self.section = section
      selectedProviderId = nil
    } label: {
      HStack(spacing: 9) {
        Image(systemName: section.systemImage)
          .font(.body.weight(.medium))
          .foregroundStyle(active ? Color.accentColor : Color.secondary)
          .frame(width: 27, height: 27)
        VStack(alignment: .leading, spacing: 1) {
          Text(section.rawValue).font(.callout.weight(.medium))
          Text(sectionSubtitle(section, count: count, active: active))
            .font(.caption).foregroundStyle(.secondary)
            .lineLimit(1)
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

  private func sectionSubtitle(
    _ section: RoutePickerSection,
    count: Int,
    active: Bool
  ) -> String {
    if active, let current {
      return "Now · \(routeFaceTitle(current))"
    }
    switch section {
    case .accounts:
      return "\(count) native account\(count == 1 ? "" : "s")"
    case .proxies:
      let hub = hubActions.isEmpty ? 0 : 1
      let rest = proxyAccountActions.count
      if hub > 0 && rest > 0 {
        return "Hub · \(rest) proxy source\(rest == 1 ? "" : "s")"
      }
      if hub > 0 { return "Proxy Hub" }
      return "\(rest) proxy source\(rest == 1 ? "" : "s")"
    case .gateways:
      return "\(count) gateway\(count == 1 ? "" : "s")"
    }
  }

  // MARK: Section contents

  @ViewBuilder private func sectionResults(_ section: RoutePickerSection) -> some View {
    switch section {
    case .accounts:
      listActions(accountActions)
    case .gateways:
      listActions(gatewayActions)
    case .proxies:
      proxiesResults
    }
  }

  @ViewBuilder private var proxiesResults: some View {
    // Hub first when present (enabled or not — disabled rows stay greyed).
    if !hubActions.isEmpty {
      pickerLabel("Proxy Hub")
      ForEach(hubActions) { action in actionButton(action) }
    }
    let proxyProviders = proxyProviderIds
    if !proxyProviders.isEmpty {
      pickerLabel(hubActions.isEmpty ? "Proxies" : "Other proxies")
      if proxyProviders.count == 1, let only = proxyProviders.first {
        // One provider: show accounts directly (Codex → Grok work / personal).
        ForEach(providerProxySources(only)) { action in actionButton(action) }
      } else {
        ForEach(proxyProviders, id: \.self) { providerId in
          proxyProviderButton(providerId)
        }
      }
    }
    if hubActions.isEmpty && proxyProviders.isEmpty {
      emptyMessage("No proxies are available")
    }
  }

  @ViewBuilder private func providerResults(_ providerId: String) -> some View {
    listActions(providerProxySources(providerId))
  }

  @ViewBuilder private func listActions(_ items: [ActionSnapshot]) -> some View {
    let sorted = items.sorted {
      if $0.selected != $1.selected { return $0.selected }
      return routeActionTitle($0).localizedCaseInsensitiveCompare(routeActionTitle($1))
        == .orderedAscending
    }
    if sorted.isEmpty {
      emptyMessage("Nothing in this group")
    } else {
      ForEach(Array(sorted.prefix(16))) { action in actionButton(action) }
      overflowHint(total: sorted.count, shown: 16)
    }
  }

  @ViewBuilder private var searchResults: some View {
    if matchingActions.isEmpty {
      emptyMessage("No matching sources")
    } else {
      pickerLabel("Results")
      ForEach(Array(matchingActions.prefix(20))) { action in actionButton(action) }
      overflowHint(total: matchingActions.count, shown: 20)
    }
  }

  // MARK: Proxy provider drill

  private var proxyProviderIds: [String] {
    Array(Set(proxyAccountActions.map(providerKey)))
      .sorted {
        nativeProviderName($0).localizedCaseInsensitiveCompare(nativeProviderName($1))
          == .orderedAscending
      }
  }

  private func providerProxySources(_ providerId: String) -> [ActionSnapshot] {
    proxyAccountActions.filter { providerKey($0) == providerId }
      .sorted {
        if $0.selected != $1.selected { return $0.selected }
        return routeActionTitle($0).localizedCaseInsensitiveCompare(routeActionTitle($1))
          == .orderedAscending
      }
  }

  private func proxyProviderButton(_ providerId: String) -> some View {
    let items = providerProxySources(providerId)
    let active = items.contains(where: \.selected)
    return Button {
      if items.count == 1, let only = items.first, !only.selected, only.enabled {
        choose(only)
        return
      }
      selectedProviderId = providerId
    } label: {
      HStack(spacing: 9) {
        NativeProviderBadge(id: providerId, size: 27)
        VStack(alignment: .leading, spacing: 1) {
          HStack(spacing: 6) {
            Text(nativeProviderName(providerId)).font(.callout.weight(.medium))
            if active {
              Text("Now")
                .font(.caption2.weight(.semibold))
                .foregroundStyle(Color.accentColor)
            }
          }
          Text("\(items.count) account\(items.count == 1 ? "" : "s")")
            .font(.caption).foregroundStyle(.secondary)
        }
        Spacer()
        if items.count > 1 {
          Image(systemName: "chevron.right")
            .font(.caption2.weight(.semibold)).foregroundStyle(.tertiary)
        }
      }
      .contentShape(Rectangle())
      .padding(.horizontal, 7)
      .padding(.vertical, 6)
    }
    .buttonStyle(AnyPickPlainButtonStyle(cornerRadius: 8))
  }

  // MARK: Rows

  private func actionButton(_ action: ActionSnapshot) -> some View {
    Button {
      choose(action)
    } label: {
      HStack(spacing: 9) {
        Image(systemName: action.selected ? "checkmark" : "")
          .font(.callout.weight(.bold))
          .foregroundStyle(Color.accentColor)
          .frame(width: 13)
        NativeProviderBadge(id: trayRouteProviderId(action), size: 25)
        VStack(alignment: .leading, spacing: 1) {
          Text(routeActionTitle(action)).font(.callout.weight(.medium)).lineLimit(1)
          Text(routeActionDetail(action))
            .font(.caption).foregroundStyle(.secondary).lineLimit(1)
        }
        Spacer()
      }
      .contentShape(Rectangle())
    }
    .buttonStyle(AnyPickPlainButtonStyle(cornerRadius: 8))
    .padding(.vertical, 4)
    .disabled(action.selected || !action.enabled || store.busyRequestId != nil)
  }

  private func choose(_ action: ActionSnapshot) {
    guard !action.selected, action.enabled else { return }
    if customRoleCount > 0 {
      pendingAction = action
    } else {
      store.invoke(action)
      showing = false
    }
  }

  private func routeResetConfirmation(_ action: ActionSnapshot) -> some View {
    VStack(spacing: 10) {
      Image(systemName: "arrow.triangle.2.circlepath")
        .font(.title3.weight(.medium))
        .foregroundStyle(anypickAmber)
      Text("Switch source and reset model overrides?")
        .font(.body.weight(.semibold))
      Text(
        trayRouteResetMessage(
          overrideCount: customRoleCount,
          destination: routeActionTitle(action)
        )
      )
      .font(.caption)
      .foregroundStyle(.secondary)
      .multilineTextAlignment(.center)
      HStack(spacing: 7) {
        Button("Cancel") { pendingAction = nil }
          .buttonStyle(.bordered)
        Button("Switch and Reset") {
          store.invoke(action)
          showing = false
        }
        .buttonStyle(.borderedProminent)
      }
      .controlSize(.small)
    }
    .frame(maxWidth: .infinity)
    .padding(.vertical, 12)
  }

  // MARK: Open active path

  /// Land in the group that owns the live route (Accounts / Proxies / Gateways).
  private func openActivePathIfNeeded() {
    guard !didOpenActivePath else { return }
    didOpenActivePath = true
    guard section == nil else { return }

    if let current, let target = sectionFor(current) {
      section = target
      if target == .proxies,
         current.routeKind == "account" || current.routeKind == "pool" {
        let key = providerKey(current)
        // Multi-account provider → open that provider list (e.g. Grok work/personal).
        if providerProxySources(key).count > 1 {
          selectedProviderId = key
        }
      }
      return
    }
    // Unbound: only auto-enter when exactly one group exists.
    if availableSections.count == 1 {
      section = availableSections[0]
    }
  }

  private func sectionFor(_ action: ActionSnapshot) -> RoutePickerSection? {
    switch action.routeKind {
    case "direct-account": return .accounts
    case "hub", "account", "pool": return .proxies
    case "gateway", nil: return .gateways
    default: return nil
    }
  }

  private func sectionTitle(for action: ActionSnapshot) -> String {
    sectionFor(action)?.rawValue ?? ""
  }

  private func items(in section: RoutePickerSection) -> [ActionSnapshot] {
    switch section {
    case .accounts: return accountActions
    case .proxies: return hubActions + proxyAccountActions
    case .gateways: return gatewayActions
    }
  }

  private func providerKey(_ action: ActionSnapshot) -> String {
    action.upstreamProviderId ?? action.sourceId
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

// MARK: - Shared source labels (chips + face + rows)

/// True when Switch / chips are useful: two or more enabled sources.
/// 0–1 sources → hide (nothing to switch to).
func routeHasAlternates(_ actions: [ActionSnapshot]) -> Bool {
  actions.filter(\.enabled).count > 1
}

func routeActionTitle(_ action: ActionSnapshot) -> String {
  if action.routeKind == "hub" {
    return action.label.isEmpty ? "Proxy Hub" : action.label
  }
  return action.label
}

func routeActionDetail(_ action: ActionSnapshot) -> String {
  if action.routeKind == "hub" {
    return action.detail ?? "Multi-model local endpoint"
  }
  if let detail = action.detail, !detail.isEmpty { return detail }
  switch action.routeKind {
  case "direct-account": return "Native account"
  case "account": return "Account proxy"
  case "pool": return "Account pool"
  case "gateway": return "Gateway"
  default: return ""
  }
}

/// Short face/chip label — account local-part or Hub, matching model picker's short face.
func routeFaceTitle(_ action: ActionSnapshot) -> String {
  if action.routeKind == "hub" { return "Hub" }
  let parts = action.label.components(separatedBy: " · ")
  if parts.count > 1 {
    let account = parts.dropFirst().joined(separator: " · ")
    if let at = account.firstIndex(of: "@") {
      return String(account[..<at])
    }
    return account
  }
  return action.label
}

struct NativeQuotaSummary: View {
  let usage: UsageSnapshot?

  var body: some View {
    TrayUsageMeter(usage: usage, barWidth: 64)
  }
}
