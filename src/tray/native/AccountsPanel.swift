import AppKit
import Foundation
import SwiftUI

// Module: AccountsPanel.swift — apps routes and hub sources

struct NativeAccountsPanel: View {
  @ObservedObject var store: TrayStore
  let openManage: () -> Void
  let openModelAccounts: () -> Void
  let openRoutingIssues: () -> Void
  let openClientModels: (String) -> Void
  let openHubSetup: () -> Void
  /// nil = auto-expand when few CLIs (discoverability); user toggle pins state.
  @State private var showingDirectClients: Bool? = nil
  @AppStorage(TrayPreferences.Key.onboardingDismissed) private var onboardingDismissed = false

  private var directClientsExpanded: Bool {
    showingDirectClients ?? (store.nativeSourceIds.count <= 3)
  }

  private var showOnboarding: Bool {
    trayShouldShowOnboarding(store: store, dismissed: onboardingDismissed)
  }

  var body: some View {
    VStack(alignment: .leading, spacing: TraySpacing.groupGap) {
      if !store.snapshotReady {
        NativeSnapshotLoading()
          .nativeGroup()
      } else if showOnboarding {
        NativeOnboardingChecklist(
          store: store,
          openAccounts: openManage,
          openHub: openHubSetup,
          compact: false
        )
        .transition(TrayMotion.panelTransition)
      }

      if !store.appRouteClients.isEmpty {
        NativeSectionHeader(
          title: "Apps",
          detail: "Where Claude Code & Codex send traffic",
          action: openManage
        ) {
          Text("Accounts…")
        }
        VStack(spacing: 0) {
          ForEach(Array(store.appRouteClients.enumerated()), id: \.element) { index, client in
            NativeAppRouteRow(
              client: client,
              route: store.route(client),
              actions: store.appActions(client),
              config: store.modelConfig(client),
              usage: store.usage(for: client),
              store: store,
              customize: { clientId in openClientModels(clientId) }
            )
            if index < store.appRouteClients.count - 1 {
              Divider().padding(.leading, TraySpacing.dividerLeading)
            }
          }
        }
        .nativeGroup()
      }

      if let hub = store.proxyHub, store.snapshotReady, !store.isFirstRun {
        NativeSectionHeader(
          title: "Proxy Hub",
          detail: "One local endpoint · many hub sources"
        ) {
          openHubSetup()
        } actionLabel: {
          Text("Set up…")
        }
        NativeHubCard(
          hub: hub,
          store: store,
          openManage: openManage,
          openModelAccounts: openModelAccounts,
          openRoutingIssues: openRoutingIssues
        )
      }

      if !store.nativeSourceIds.isEmpty {
        VStack(spacing: 0) {
          Button {
            withAnimation(TrayMotion.standard) {
              showingDirectClients = !directClientsExpanded
            }
          } label: {
            HStack(spacing: 10) {
              Image(systemName: "terminal")
                .font(.body.weight(.medium))
                .foregroundStyle(.secondary)
                .frame(width: 28, height: 28)
                .background(
                  RoundedRectangle(cornerRadius: 7, style: .continuous)
                    .fill(Color.primary.opacity(0.05))
                )
              VStack(alignment: .leading, spacing: 2) {
                Text("Other CLIs")
                  .font(.body.weight(.medium))
                Text(
                  "\(store.nativeSourceIds.count) direct client\(store.nativeSourceIds.count == 1 ? "" : "s") · account switching only"
                )
                .font(.caption)
                .foregroundStyle(.secondary)
              }
              Spacer()
              Image(systemName: directClientsExpanded ? "chevron.up" : "chevron.down")
                .font(.caption.weight(.semibold))
                .foregroundStyle(.tertiary)
            }
            .contentShape(Rectangle())
            .padding(.horizontal, TraySpacing.rowPadding)
            .padding(.vertical, 10)
          }
          .buttonStyle(AnyPickPlainButtonStyle(cornerRadius: 10))
          .accessibilityLabel("Other CLIs")
          .accessibilityHint(
            directClientsExpanded ? "Collapse direct clients" : "Expand direct clients"
          )
          .accessibilityValue(
            "\(store.nativeSourceIds.count) client\(store.nativeSourceIds.count == 1 ? "" : "s")"
          )

          if directClientsExpanded {
            Divider().padding(.leading, TraySpacing.dividerLeading)
            ForEach(Array(store.nativeSourceIds.enumerated()), id: \.element) { index, sourceId in
              NativeOnlyRouteRow(
                sourceId: sourceId,
                actions: store.nativeSourceActions(sourceId),
                usage: usage(for: sourceId),
                store: store
              )
              if index < store.nativeSourceIds.count - 1 {
                Divider().padding(.leading, TraySpacing.dividerLeading)
              }
            }
          }
        }
        .nativeGroup()
      }

      // First-run / needs-apps covered by NativeOnboardingChecklist above.
    }
  }

  private func usage(for sourceId: String) -> UsageSnapshot? {
    store.usage(for: sourceId)
  }
}
struct NativeHubCard: View {
  let hub: ProxySnapshot
  @ObservedObject var store: TrayStore
  let openManage: () -> Void
  let openModelAccounts: () -> Void
  let openRoutingIssues: () -> Void

  private var hasSources: Bool { (hub.sourceCount ?? 0) > 0 }
  private var enabledSources: [HubSourceSnapshot] { store.hubSources.filter(\.enabled) }
  private var issueCount: Int { store.routingIssueCount }
  private var choiceCount: Int { store.routingChoiceCount }

  private var statusTitle: String {
    if issueCount > 0 { return "Needs attention" }
    if choiceCount > 0 { return "Choose a source" }
    if hub.running { return "Active" }
    if hasSources { return "Ready" }
    return "Set up sources"
  }

  private var statusKind: NativeStatusDot.Kind {
    if issueCount > 0 { return .warn }
    if choiceCount > 0 { return .warn }
    if hub.running { return .on }
    return hasSources ? .on : .off
  }

  var body: some View {
    VStack(alignment: .leading, spacing: 12) {
      HStack(spacing: 12) {
        NativeProviderBadge(id: "proxy-hub", size: 36)
        VStack(alignment: .leading, spacing: 3) {
          Text("Multi-model routing")
            .font(.body.weight(.semibold))
          HStack(spacing: 6) {
            NativeStatusDot(kind: statusKind, title: statusTitle)
            Text(
              "· \(hub.sourceCount ?? 0) accounts · \(hub.modelCount ?? 0) models · \(hub.clientCount ?? 0) apps"
            )
            .font(.caption)
            .foregroundStyle(.secondary)
            .lineLimit(1)
          }
        }
        Spacer(minLength: 8)
      }

      Divider()

      if store.hubSources.isEmpty {
        HStack(spacing: 10) {
          Image(systemName: "person.crop.circle.badge.plus")
            .font(.body.weight(.medium))
            .foregroundStyle(Color.accentColor)
            .frame(width: 28, height: 28)
            .background(
              RoundedRectangle(cornerRadius: 7, style: .continuous)
                .fill(Color.accentColor.opacity(0.1))
            )
          VStack(alignment: .leading, spacing: 2) {
            Text("No supported accounts yet")
              .font(.callout.weight(.semibold))
            Text("Add OpenCode, Gemini, or Grok first.")
              .font(.caption)
              .foregroundStyle(.secondary)
          }
          Spacer()
          Button("Add Account", action: openManage)
            .buttonStyle(.borderedProminent)
            .controlSize(.small)
        }
      } else {
        HStack(spacing: 10) {
          HStack(spacing: -6) {
            ForEach(Array(enabledSources.prefix(3))) { source in
              NativeProviderBadge(id: source.providerId, size: 26)
                .overlay(
                  RoundedRectangle(cornerRadius: 6, style: .continuous)
                    .stroke(nativeWindowFill, lineWidth: 2)
                )
            }
          }
          if enabledSources.count > 3 {
            Text("+\(enabledSources.count - 3)")
              .font(.caption.weight(.semibold))
              .foregroundStyle(.secondary)
          }
          VStack(alignment: .leading, spacing: 2) {
            Text(
              enabledSources.isEmpty
                ? "No hub sources enabled"
                : "\(enabledSources.count) hub \(enabledSources.count == 1 ? "source" : "sources") enabled"
            )
            .font(.callout.weight(.semibold))
            Text("Choose which accounts contribute models.")
              .font(.caption)
              .foregroundStyle(.secondary)
          }
          Spacer(minLength: 6)
          Button("Sources…", action: openModelAccounts)
            .buttonStyle(.bordered)
            .controlSize(.small)
        }
      }

      if issueCount > 0 {
        TrayAttentionCallout(
          kind: .warning,
          title: "\(issueCount) routing \(issueCount == 1 ? "issue" : "issues") — pick a source or fix unavailable accounts",
          actionTitle: "Fix"
        ) {
          openRoutingIssues()
        }
      } else if choiceCount > 0 {
        TrayAttentionCallout(
          kind: .info,
          title: "Choose \(choiceCount) hub source\(choiceCount == 1 ? "" : "s") for overlapping models",
          actionTitle: "Choose"
        ) {
          openRoutingIssues()
        }
      }
    }
    .padding(14)
    .nativeGroup()
  }
}

struct NativeHubSourceRow: View {
  let source: HubSourceSnapshot
  @ObservedObject var store: TrayStore
  @State private var optimisticEnabled: Bool?

  private var displayedEnabled: Bool { optimisticEnabled ?? source.enabled }

  var body: some View {
    HStack(alignment: .top, spacing: 10) {
      NativeProviderBadge(id: source.providerId, size: 30)
      VStack(alignment: .leading, spacing: 3) {
        Text(source.label)
          .font(.callout.weight(.medium))
          .lineLimit(1)
        HStack(spacing: 5) {
          Text(source.detail).lineLimit(1)
          if let modelCount = source.modelCount {
            Text("· \(modelCount) models")
          }
        }
        .font(.caption)
        .foregroundStyle(.secondary)
        if let warning = source.warning, !warning.isEmpty {
          Label(warning, systemImage: "exclamationmark.triangle.fill")
            .font(.caption)
            .foregroundStyle(anypickAmber)
            .lineLimit(2)
        }
      }
      Spacer(minLength: 8)
      AnyPickSwitch(
        title: "Enable \(source.label)",
        isOn: Binding(
          get: { displayedEnabled },
          set: { enabled in
            optimisticEnabled = enabled
            store.mutate(
              operation: "hub-source-toggle",
              name: source.name,
              providerId: source.providerId,
              enabled: enabled,
              activityLabel: "updating \(source.label)"
            )
          }
        ),
        isEnabled: store.busyRequestId == nil
      )
    }
    .padding(.horizontal, 12)
    .padding(.vertical, 10)
    .onChange(of: source.enabled) { _, _ in optimisticEnabled = nil }
    .onChange(of: store.busyRequestId) { _, requestId in
      if requestId == nil { optimisticEnabled = nil }
    }
  }
}

enum NativeHubSourceFilter: String, CaseIterable, Identifiable {
  case all = "All"
  case enabled = "Enabled"

  var id: String { rawValue }
}

struct NativeModelAccountsPanel: View {
  @ObservedObject var store: TrayStore
  let openManage: () -> Void
  @State private var search = ""
  @State private var filter = NativeHubSourceFilter.all

  private var filteredSources: [HubSourceSnapshot] {
    let query = search.trimmingCharacters(in: .whitespacesAndNewlines)
    return store.hubSources.filter { source in
      let matchesFilter = filter == .all || source.enabled
      let matchesQuery = query.isEmpty ||
        source.label.localizedCaseInsensitiveContains(query) ||
        source.detail.localizedCaseInsensitiveContains(query) ||
        source.providerId.localizedCaseInsensitiveContains(query) ||
        (source.warning?.localizedCaseInsensitiveContains(query) ?? false)
      return matchesFilter && matchesQuery
    }
    .sorted {
      if $0.enabled != $1.enabled { return $0.enabled }
      return $0.label.localizedCaseInsensitiveCompare($1.label) == .orderedAscending
    }
  }

  private var providerIds: [String] {
    Array(Set(filteredSources.map { nativeProviderFamily($0.providerId) }))
      .sorted {
        nativeProviderRank($0) == nativeProviderRank($1)
          ? nativeProviderName($0) < nativeProviderName($1)
          : nativeProviderRank($0) < nativeProviderRank($1)
      }
  }

  var body: some View {
    VStack(alignment: .leading, spacing: 14) {
      HStack(spacing: 10) {
        NativeSearchField(placeholder: "Search hub sources", text: $search)
        Picker("Filter", selection: $filter) {
          ForEach(NativeHubSourceFilter.allCases) { item in
            Text(item.rawValue).tag(item)
          }
        }
        .pickerStyle(.segmented)
        .labelsHidden()
        .frame(width: 160)
      }

      HStack {
        Text("\(store.hubSources.filter(\.enabled).count) of \(store.hubSources.count) enabled")
          .font(.caption)
          .foregroundStyle(.secondary)
        Spacer()
        Button("Add Account", action: openManage)
          .buttonStyle(.bordered)
          .controlSize(.small)
      }

      if providerIds.isEmpty {
        NativeEmptyState(
          title: store.hubSources.isEmpty ? "No hub sources yet" : "No matching sources",
          systemImage: store.hubSources.isEmpty
            ? "person.crop.circle.badge.plus"
            : "magnifyingglass",
          description: store.hubSources.isEmpty
            ? "Add an OpenCode, Gemini, or Grok account under Saved accounts."
            : "Try another search or show all sources."
        )
        .nativeGroup()
      } else {
        ForEach(providerIds, id: \.self) { providerId in
          let sources = filteredSources.filter { nativeProviderFamily($0.providerId) == providerId }
          NativeSectionHeader(
            title: nativeProviderName(providerId),
            detail: "\(sources.filter(\.enabled).count) enabled · \(sources.count) shown"
          )
          LazyVStack(spacing: 0) {
            ForEach(Array(sources.enumerated()), id: \.element.id) { index, source in
              NativeHubSourceRow(source: source, store: store)
              if index < sources.count - 1 {
                Divider().padding(.leading, 52)
              }
            }
          }
          .nativeGroup()
        }
      }
    }
  }
}
