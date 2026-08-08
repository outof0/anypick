import AppKit
import Foundation
import SwiftUI

// Module: MonitorPanel.swift — live logs + recent activity.

struct NativeMonitorPanel: View {
  @ObservedObject var store: TrayStore
  @State private var stickToBottom = true

  private var selectedSource: LogSourceSnapshot? {
    store.logSources.first { $0.id == store.selectedLogSourceId } ?? store.logSources.first
  }

  private var hubHealthColor: Color {
    if store.routingIssueCount > 0 { return anypickAmber }
    if store.routingChoiceCount > 0 { return Color.accentColor }
    return anypickSuccess
  }

  private var hubHealthSymbol: String {
    if store.routingIssueCount > 0 { return "exclamationmark.triangle.fill" }
    if store.routingChoiceCount > 0 { return "person.crop.circle.badge.questionmark" }
    return "checkmark.shield"
  }

  var body: some View {
    VStack(alignment: .leading, spacing: 12) {
      NativeSectionHeader(title: "Live Logs", detail: "Local services · auto-refresh while open")

      if let source = selectedSource {
        VStack(alignment: .leading, spacing: 10) {
          HStack(spacing: 10) {
            NativeProviderBadge(id: source.providerId, size: 30)
            Picker(
              "Log source",
              selection: Binding(
                get: { source.id },
                set: { store.selectLogSource($0) }
              )
            ) {
              ForEach(store.logSources) { item in
                Text(item.label).tag(item.id)
              }
            }
            .labelsHidden()
            .pickerStyle(.menu)
            .frame(maxWidth: 280, alignment: .leading)
            .accessibilityLabel("Log source")
            Text(source.detail)
              .font(.caption)
              .foregroundStyle(.secondary)
              .lineLimit(1)
            Spacer(minLength: 8)
            if store.loadingLogSourceId == source.id {
              ProgressView()
                .controlSize(.small)
                .accessibilityLabel("Loading logs")
            } else {
              Text("Live")
                .font(.caption.weight(.medium))
                .foregroundStyle(anypickSuccess)
                .accessibilityLabel("Live updates")
            }
            Button("Refresh") {
              store.requestLogs(source)
            }
            .help("Refresh this log stream")
            .disabled(store.loadingLogSourceId != nil)
            Button("Copy") {
              store.copyLogs(for: source.id)
            }
            .help("Copy visible logs")
            .disabled(!canCopyLogs(source))
          }
          .buttonStyle(.bordered)
          .controlSize(.small)

          NativeLogViewer(
            text: logText(for: source),
            isPlaceholder: isPlaceholder(source),
            stickToBottom: $stickToBottom
          )
          .frame(maxWidth: .infinity, maxHeight: .infinity, alignment: .topLeading)
        }
        .padding(12)
        .frame(maxWidth: .infinity, maxHeight: .infinity, alignment: .topLeading)
        .nativeGroup()
      } else {
        NativeEmptyState(
          title: "No log sources available",
          systemImage: "doc.text.magnifyingglass",
          description: "Start a proxy service to inspect its local logs."
        )
        .frame(maxWidth: .infinity, maxHeight: .infinity)
        .nativeGroup()
      }

      if let hub = store.proxyHub, let actionId = hub.testActionId {
        HStack(spacing: 12) {
          Image(systemName: hubHealthSymbol)
            .font(.title3.weight(.medium))
            .foregroundStyle(hubHealthColor)
            .frame(width: 28, height: 28)
            .background(
              RoundedRectangle(cornerRadius: 8, style: .continuous)
                .fill(hubHealthColor.opacity(0.1))
            )
          VStack(alignment: .leading, spacing: 2) {
            Text("Routing health")
              .font(.callout.weight(.semibold))
            Text(
              store.routingIssueCount > 0
                ? "Resolve routing issues, then verify catalogs and the listener."
                : store.routingChoiceCount > 0
                  ? "Choose the hub source, then run the routing check."
                  : hub.running
                    ? "Refresh provider models and verify the owned listener."
                    : "Contacts providers and starts the listener if needed."
            )
            .font(.caption)
            .foregroundStyle(.secondary)
            .lineLimit(2)
          }
          Spacer(minLength: 8)
          Button("Run Check") {
            store.invoke(actionId: actionId, label: "routing check")
          }
          .buttonStyle(.borderedProminent)
          .controlSize(.small)
          .disabled(store.busyRequestId != nil)
          .help("Verify hub routing and refresh provider catalogs")
        }
        .padding(.horizontal, 12)
        .padding(.vertical, 10)
        .nativeGroup()
      }

      VStack(alignment: .leading, spacing: 6) {
        NativeSectionHeader(
          title: "Recent activity",
          detail: "Switches, account changes, and proxy actions"
        )
        if store.activity.isEmpty {
          Text("Switches, account changes, and proxy actions appear here.")
            .font(.callout)
            .foregroundStyle(.secondary)
            .frame(maxWidth: .infinity, alignment: .leading)
            .padding(.vertical, 12)
            .padding(.horizontal, 12)
            .nativeGroup()
        } else {
          VStack(spacing: 0) {
            let events = Array(store.activity.prefix(6))
            ForEach(Array(events.enumerated()), id: \.element.id) { index, event in
              NativeActivityEventRow(event: event)
              if index < events.count - 1 {
                Divider().padding(.leading, 52)
              }
            }
          }
          .nativeGroup()
        }
      }
    }
    .frame(maxWidth: .infinity, maxHeight: .infinity, alignment: .topLeading)
    .onAppear {
      selectDefaultLogSource(load: true)
      if let source = selectedSource {
        store.startLogPolling(for: source.id)
      }
    }
    .onDisappear {
      store.stopLogPolling()
    }
    .onChange(of: store.logSources.map(\.id)) { _, _ in
      selectDefaultLogSource(load: false)
      if let source = selectedSource {
        store.startLogPolling(for: source.id)
      }
    }
    .onChange(of: store.selectedLogSourceId) { _, sourceId in
      stickToBottom = true
      loadSelectedSourceIfNeeded()
      if !sourceId.isEmpty {
        store.startLogPolling(for: sourceId)
      }
    }
    .onChange(of: store.loadingLogSourceId) { _, sourceId in
      if sourceId == nil { loadSelectedSourceIfNeeded() }
    }
  }

  private func selectDefaultLogSource(load: Bool) {
    if !store.logSources.contains(where: { $0.id == store.selectedLogSourceId }),
       let first = store.logSources.first {
      store.selectLogSource(first.id)
    }
    if load, let source = selectedSource { store.requestLogs(source) }
  }

  private func loadSelectedSourceIfNeeded() {
    guard let source = selectedSource, store.logsBySource[source.id] == nil else { return }
    store.requestLogs(source)
  }

  private func logText(for source: LogSourceSnapshot) -> String {
    if store.loadingLogSourceId == source.id, store.logsBySource[source.id] == nil {
      return "Loading \(source.label) logs…"
    }
    let text = store.logsBySource[source.id] ?? ""
    switch store.logStatesBySource[source.id] {
    case "not-running": return "Service is not running."
    case "error": return text.isEmpty ? "Could not load logs." : text
    case "empty": return "No log entries yet."
    case "ready": return text.isEmpty ? "No log entries yet." : text
    default: return text.isEmpty ? "No log entries yet." : text
    }
  }

  private func isPlaceholder(_ source: LogSourceSnapshot) -> Bool {
    let state = store.logStatesBySource[source.id]
    if store.loadingLogSourceId == source.id, store.logsBySource[source.id] == nil {
      return true
    }
    if state == "not-running" || state == "empty" { return true }
    let text = store.logsBySource[source.id] ?? ""
    return text.isEmpty
  }

  private func canCopyLogs(_ source: LogSourceSnapshot) -> Bool {
    guard store.logsBySource[source.id]?.isEmpty == false else { return false }
    let state = store.logStatesBySource[source.id]
    return state == nil || state == "ready"
  }
}

// MARK: - Log viewer

struct NativeLogViewer: View {
  let text: String
  let isPlaceholder: Bool
  @Binding var stickToBottom: Bool

  private var lines: [String] {
    if text.isEmpty { return [""] }
    return text.split(separator: "\n", omittingEmptySubsequences: false).map(String.init)
  }

  var body: some View {
    Group {
      if isPlaceholder {
        // No ScrollView — short status must stay top-leading (ScrollView centers).
        Text(text)
          .font(.system(size: 11.5, weight: .regular, design: .monospaced))
          .foregroundStyle(Color.secondary)
          .multilineTextAlignment(.leading)
          .frame(maxWidth: .infinity, maxHeight: .infinity, alignment: .topLeading)
          .padding(12)
      } else {
        // Bare ScrollView centers undersized children — pin content to topLeading
        // by giving it at least the full viewport size.
        GeometryReader { geo in
          let viewportW = max(geo.size.width, 1)
          let viewportH = max(geo.size.height, 1)
          ScrollViewReader { proxy in
            ScrollView([.vertical, .horizontal], showsIndicators: false) {
              VStack(alignment: .leading, spacing: 1) {
                ForEach(Array(lines.enumerated()), id: \.offset) { index, line in
                  Text(line.isEmpty ? " " : line)
                    .font(.system(size: 11.5, weight: .regular, design: .monospaced))
                    .foregroundStyle(logLineColor(line))
                    .multilineTextAlignment(.leading)
                    .frame(maxWidth: .infinity, alignment: .leading)
                    .textSelection(.enabled)
                    .id(index)
                }
              }
              .padding(12)
              .frame(
                minWidth: viewportW,
                maxWidth: .infinity,
                minHeight: viewportH,
                alignment: .topLeading
              )
              .id("log-bottom-\(lines.count)")
            }
            .onChange(of: text) { _, _ in
              guard stickToBottom else { return }
              DispatchQueue.main.async {
                proxy.scrollTo(lines.count - 1, anchor: .bottom)
              }
            }
            .onAppear {
              if stickToBottom {
                proxy.scrollTo(lines.count - 1, anchor: .bottom)
              }
            }
          }
        }
      }
    }
    .frame(maxWidth: .infinity, maxHeight: .infinity, alignment: .topLeading)
    .background(
      RoundedRectangle(cornerRadius: 8, style: .continuous)
        .fill(Color.black.opacity(0.78))
    )
    .overlay(
      RoundedRectangle(cornerRadius: 8, style: .continuous)
        .stroke(nativeStroke.opacity(0.7), lineWidth: 0.5)
    )
    .clipShape(RoundedRectangle(cornerRadius: 8, style: .continuous))
  }

  private func logLineColor(_ line: String) -> Color {
    let lower = line.lowercased()
    if lower.contains("error")
      || lower.contains("fatal")
      || lower.contains("exception")
      || lower.contains("traceback")
      || lower.contains(" failed")
      || lower.contains("✗")
      || lower.hasPrefix("e ") {
      return anypickRed
    }
    if lower.contains("warn")
      || lower.contains("attention")
      || lower.contains("timeout")
      || lower.contains("retry") {
      return anypickAmber
    }
    if lower.contains("started")
      || lower.contains("success")
      || lower.contains("ready")
      || lower.contains("listening")
      || lower.contains("✓")
      || lower.contains(" ← ") {
      return anypickSuccess.opacity(0.92)
    }
    // Terminal-style body text (Tauri log-viewer green tint).
    return Color(red: 0.55, green: 0.90, blue: 0.68).opacity(0.92)
  }
}

struct NativeActivityEventRow: View {
  let event: ActivityEvent

  var body: some View {
    HStack(alignment: .firstTextBaseline, spacing: 10) {
      Text(event.date, style: .time)
        .font(.caption.monospaced())
        .foregroundStyle(.secondary)
        .frame(width: 60, alignment: .leading)
      Image(systemName: event.isError ? "exclamationmark.circle.fill" : activitySymbol(event.kind))
        .foregroundStyle(event.isError ? anypickRed : anypickSuccess)
      Text(event.message)
        .font(.callout)
        .lineLimit(2)
      Spacer()
    }
    .padding(12)
  }

  private func activitySymbol(_ kind: String) -> String {
    switch kind {
    case "switch": return "arrow.left.arrow.right.circle.fill"
    case "account": return "person.crop.circle.fill"
    case "gateway": return "network"
    case "proxy": return "bolt.circle.fill"
    case "quota": return "arrow.triangle.2.circlepath.circle.fill"
    case "settings": return "gearshape.fill"
    default: return "checkmark.circle.fill"
    }
  }
}
