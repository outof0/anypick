import AppKit
import SwiftUI

enum ActivityCategory: String, CaseIterable, Identifiable {
  case all = "All Events"
  case routing = "Routing"
  case accounts = "Accounts & APIs"
  case proxies = "Proxy Hub"
  case issues = "Issues"

  var id: String { rawValue }

  @MainActor
  func localizedTitle(using model: MacOSDesignModel) -> String {
    let key: String
    switch self {
    case .all: key = "desktop.activity.category_all"
    case .routing: key = "desktop.activity.category_routing"
    case .accounts: key = "desktop.activity.category_accounts"
    case .proxies: key = "desktop.activity.category_proxies"
    case .issues: key = "desktop.activity.category_issues"
    }
    return model.localized(key)
  }

  var symbol: String {
    switch self {
    case .all: return "clock.arrow.circlepath"
    case .routing: return "arrow.triangle.2.circlepath"
    case .accounts: return "person.crop.circle"
    case .proxies: return "network"
    case .issues: return "exclamationmark.triangle"
    }
  }

  func matches(_ item: DesignActivity) -> Bool {
    switch self {
    case .all:
      return true
    case .routing:
      if let kind = item.kind { return kind == "activation" }
      let lower = "\(item.title) \(item.detail)".lowercased()
      return lower.contains("uses") || lower.contains("routing") || lower.contains("switched") || lower.contains("route")
    case .accounts:
      if let kind = item.kind { return ["account", "gateway", "quota"].contains(kind) }
      let lower = "\(item.title) \(item.detail)".lowercased()
      return lower.contains("account") || lower.contains("login") || lower.contains("gateway") || lower.contains("backup")
    case .proxies:
      if let kind = item.kind { return kind == "proxy" }
      let lower = "\(item.title) \(item.detail)".lowercased()
      return lower.contains("proxy") || lower.contains("hub") || lower.contains("service") || lower.contains("port")
    case .issues:
      return item.status == .attention
    }
  }
}

struct ActivityView: View {
  @ObservedObject var model: MacOSDesignModel
  @State private var confirmation: DesignConfirmation?
  @State private var searchQuery = ""
  @State private var selectedCategory: ActivityCategory = .all

  var body: some View {
    GeometryReader { geometry in
      // 230 = pane header, mode control, the Form's top/bottom margins and
      // the pane action row, which now sits below the Form (it used to be in
      // the section footer, inside the Form). With the old 180 the Form was
      // ~50pt taller than its viewport and drew a scroll bar with nothing to
      // scroll. Shared by Events and Live Logs.
      let contentHeight = max(320, geometry.size.height - 230)
      activityPane(contentHeight: contentHeight)
        .frame(width: geometry.size.width, height: geometry.size.height)
    }
    .toolbar { activityToolbar }
    .onChange(of: model.activityShowsLogs) { _, enabled in
      searchQuery = ""
      model.setActivityShowsLogs(enabled)
      model.setLogPolling(enabled)
    }
    .onChange(of: model.selectedLogSourceID) {
      if model.activityShowsLogs { model.setLogPolling(true) }
    }
    .onAppear {
      if model.activityShowsLogs { model.setLogPolling(true) }
    }
    .onDisappear {
      model.setLogPolling(false)
    }
    .designConfirmation($confirmation, model: model)
  }

  /// One question, two subjects: the pane's segmented control decides whether
  /// the user is looking at logs or at events, and both clear the same store.
  private func requestClear() {
    confirmation = DesignConfirmation(
      id: "clear-activity",
      title: model.localized(model.activityShowsLogs ? "desktop.activity.clear_visible_logs" : "desktop.activity.clear_visible_events"),
      message: model.localized("desktop.activity.clear_message"),
      action: .confirm(model.localized("desktop.common.clear")) { model.clearActivity() }
    )
  }

  /// Filter + search stay mounted. Adding/removing toolbar items when the
  /// segmented control flips is what crashed Live Logs.
  @ToolbarContentBuilder
  private var activityToolbar: some ToolbarContent {
    ToolbarItem(placement: .automatic) {
      if model.activityShowsLogs {
        Menu {
          Picker(
            model.localized("desktop.activity.log_source"),
            selection: Binding(
              get: { model.selectedLogSourceID },
              set: { model.selectLogSource($0) }
            )
          ) {
            if model.logSources.isEmpty {
              Text(model.localized("desktop.activity.no_sources")).tag("")
            } else {
              ForEach(model.logSources) { source in
                Text(source.label).tag(source.id)
              }
            }
          }
          // Inline (not menu) style: the sources list flat, with a checkmark
          // on the selected one — no nested "Log Source >" submenu.
          .pickerStyle(.inline)
        } label: {
          Label(model.localized("desktop.activity.filter_logs"), systemImage: "line.3.horizontal.decrease")
        }
        .labelStyle(.iconOnly)
        .help(model.localized("desktop.activity.filter_logs_help"))
        .disabled(model.logSources.isEmpty)
        .accessibilityIdentifier("activity.logs.filter")
      } else {
        Menu {
          Picker(model.localized("desktop.activity.filter_events"), selection: $selectedCategory) {
            ForEach(ActivityCategory.allCases) { cat in
              Text(cat.localizedTitle(using: model)).tag(cat)
            }
          }
          .pickerStyle(.inline)
        } label: {
          Label(
            model.localized("desktop.activity.filter_events"),
            systemImage: selectedCategory == .all
              ? "line.3.horizontal.decrease"
              : "line.3.horizontal.decrease.circle.fill"
          )
        }
        .labelStyle(.iconOnly)
        .help(model.localized("desktop.activity.filter_events_help"))
        .accessibilityIdentifier("activity.logs.filter")
      }
    }
    ToolbarItem(placement: .primaryAction) {
      DesignToolbarSearch(
        text: $searchQuery,
        prompt: model.localized(model.activityShowsLogs ? "desktop.activity.search_logs" : "desktop.activity.search_events")
      )
      .frame(minWidth: 180, idealWidth: 220, maxWidth: 280)
    }
  }

  @ViewBuilder
  private func activityPane(contentHeight: CGFloat) -> some View {
    // Clear sits in the pane action row, not in the section footer: a footer
    // is inset ~10pt inside the card column, so the button ended short of
    // the cards' trailing edge (-19px @2x).
    DesignGroupedPane(fillHeight: true, actions: { activityActions }) {
      Section {
        paneHeader
        modeControl
        if model.activityShowsLogs {
          logStateNotice
          logsRows(height: contentHeight)
        } else if filteredActivity.isEmpty {
          emptyState(
            symbol: "clock.arrow.circlepath",
            message: searchQuery.isEmpty
              ? (selectedCategory == .all
                  ? model.localized("desktop.activity.no_events")
                  : model.localized("desktop.activity.no_results_detail"))
              : model.localized("desktop.activity.no_results_detail")
          )
        } else {
          eventsWell(height: contentHeight)
        }
      } footer: {
        if model.activityShowsLogs {
          Text(model.localized("desktop.activity.sensitive_redacted"))
        }
      }
    }
  }

  private var activityActions: some View {
    DesignPaneActions {
      if model.activityShowsLogs {
        DesignSheetButton(
          title: model.localized("desktop.activity.clear_log"),
          enabled: !filteredLogLines.isEmpty,
          destructive: true,
          identifier: "activity.clear-log"
        ) { requestClear() }
      } else {
        DesignSheetButton(
          title: model.localized("desktop.activity.clear_events"),
          enabled: !filteredActivity.isEmpty,
          destructive: true,
          identifier: "activity.clear-events"
        ) { requestClear() }
      }
    }
  }

  private var paneHeader: some View {
    Text(model.localized("desktop.activity.changes_header"))
      .font(.subheadline)
      .foregroundStyle(.secondary)
      .frame(maxWidth: .infinity, alignment: .leading)
      .listRowInsets(rowInsets)
      .accessibilityIdentifier("activity.header")
  }

  private let rowInsets = EdgeInsets(top: 6, leading: 12, bottom: 6, trailing: 12)

/// Segmented control only — the category filter belongs in the toolbar, not
/// beside the tabs.
  private var modeControl: some View {
    Picker(model.localized("desktop.activity.view"), selection: $model.activityShowsLogs) {
      Text(model.localized("desktop.activity.events")).tag(false)
      Text(model.localized("desktop.activity.live_logs")).tag(true)
    }
    .pickerStyle(.segmented)
    .labelsHidden()
    .controlSize(.regular)
    .accessibilityLabel(model.localized("desktop.activity.view"))
    .accessibilityIdentifier("activity.mode")
    .accessibilityIdentifier("activity.mode.picker")
  }

  /// Events well, mirroring the log viewer: hugs short content but grows to
  /// fill the pane's full height (the enclosing `DesignGroupedPane` is opened
  /// with `fillHeight: true`) so the Activity view no longer floats with empty
  /// space below. Scrolls past a long list — the controls above stay put.
  private func eventsWell(height: CGFloat) -> some View {
    ScrollView {
      LazyVStack(alignment: .leading, spacing: 0) {
        ForEach(eventSections, id: \.key) { section in
          dayHeader(section.key)
            .padding(.top, section.key == eventSections.first?.key ? 0 : 8)
          ForEach(section.items) { item in
            eventRow(item)
              .padding(.vertical, 6)
            if item.id != section.items.last?.id {
              Divider()
            }
          }
        }
      }
      .padding(8)
    }
    // Fills the space the window leaves for it (see contentHeight in body);
    // it scrolls only when the history really overflows.
    .frame(maxWidth: .infinity, minHeight: height, maxHeight: .infinity)
    .accessibilityIdentifier("activity.events.well")
  }

  private func dayHeader(_ label: String) -> some View {
    Text(label)
      .foregroundStyle(.secondary)
      .listRowInsets(rowInsets)
      .accessibilityAddTraits(.isHeader)
      .accessibilityLabel(label)
  }

  private func eventRow(_ item: DesignActivity) -> some View {
    let title = item.localizedTitle(using: model)
    let detail = item.localizedDetail(using: model)
    return HStack(alignment: .center, spacing: 10) {
      Text(item.time)
        .foregroundStyle(.secondary)
        .monospacedDigit()
        .frame(width: 62, alignment: .leading)
        .accessibilityHidden(true)
      Image(
        systemName: item.status == .ready || item.status == .running
          ? item.symbol : item.status.symbol
      )
      .foregroundStyle(item.status.color)
      .frame(width: 16)
      .accessibilityHidden(true)
      VStack(alignment: .leading, spacing: 2) {
        HStack(spacing: 6) {
          if let provider = item.provider {
            DesignProviderIcon(provider: provider, fallbackSymbol: item.symbol, size: 16)
              .accessibilityHidden(true)
          }
          Text(title)
            .fontWeight(.medium)
            .lineLimit(1)
        }
        if !detail.isEmpty {
          Text(detail)
            .font(.caption)
            .foregroundStyle(.secondary)
            .lineLimit(2)
        }
      }
    }
    .listRowInsets(rowInsets)
    .contextMenu {
      Button(model.localized("desktop.activity.copy_message")) {
        if model.pasteString(title) {
          model.announceOnly(model.localized("desktop.activity.copied_message"))
        } else {
          model.announceOnly(model.localized("desktop.activity.copy_message_failed"))
        }
      }
      .help(model.localized("desktop.activity.copy_message_help"))
      Button(model.localized("desktop.activity.copy_details")) {
        if model.pasteString("\(item.localizedDay(using: model)) \(item.time): \(title) - \(detail)") {
          model.announceOnly(model.localized("desktop.activity.copied_details"))
        } else {
          model.announceOnly(model.localized("desktop.activity.copy_details_failed"))
        }
      }
      .help(model.localized("desktop.activity.copy_details_help"))
    }
    .accessibilityElement(children: .combine)
    .accessibilityLabel(activityAccessibilityLabel(for: item, title: title, detail: detail, model: model))
    .accessibilityIdentifier("activity.event.\(item.id)")
  }

  private var eventSections: [(key: String, items: [DesignActivity])] {
    var sections: [(String, [DesignActivity])] = []
    for item in filteredActivity {
      let day = item.localizedDay(using: model)
      if sections.last?.0 == day {
        sections[sections.count - 1].1.append(item)
      } else {
        sections.append((day, [item]))
      }
    }
    return sections.map { (key: $0.0, items: $0.1) }
  }

  @ViewBuilder
  private func logsRows(height: CGFloat) -> some View {
    if model.logState == .ready {
      LabeledContent(model.localized("desktop.activity.status"), value: model.localized("desktop.activity.live"))
        .accessibilityIdentifier("activity.logs.live")
        .listRowInsets(rowInsets)
    }
    ActivityLogViewer(lines: Array(filteredLogLines.suffix(200)), placeholder: logPlaceholder)
      .frame(maxWidth: .infinity, minHeight: height, maxHeight: .infinity)
      .listRowInsets(rowInsets)
  }

  private var logPlaceholder: String? {
    guard filteredLogLines.isEmpty else { return nil }
    if !searchQuery.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty {
      return model.localized("desktop.activity.no_matching_lines")
    }
    switch model.logState {
    case .loading: return model.localized("desktop.activity.loading_logs")
    case .stopped: return model.localized("desktop.activity.proxy_not_running")
    case .empty: return model.localized("desktop.activity.no_entries")
    case .error: return model.localized("desktop.activity.could_not_load")
    case .unavailable: return model.localized("desktop.activity.no_log_source")
    case .idle, .ready: return model.localized("desktop.activity.log_output_hint")
    }
  }

  private func emptyState(symbol: String, message: String) -> some View {
    VStack(spacing: 6) {
      Image(systemName: symbol)
        .font(.title3)
        .foregroundStyle(.tertiary)
      Text(message)
        .foregroundStyle(.secondary)
        .multilineTextAlignment(.center)
    }
    .frame(maxWidth: .infinity, maxHeight: .infinity, alignment: .center)
    .accessibilityElement(children: .combine)
    .listRowInsets(rowInsets)
  }

  @ViewBuilder
  private var logStateNotice: some View {
    switch model.logState {
    case .idle, .ready, .stopped:
      // Stopped shows no notice block: the log viewer placeholder already
      // says the proxy is not running. A notice + placeholder says it twice.
      EmptyView()
    case .loading:
      HStack(spacing: 8) {
        ProgressView()
          .controlSize(.small)
        Text(model.logStateMessage ?? model.localized("desktop.activity.loading_logs"))
          .foregroundStyle(.secondary)
      }
      .accessibilityIdentifier("activity.logs.loading")
      .listRowInsets(rowInsets)
    case .empty:
      logNotice(
        title: model.localized("desktop.activity.no_logs"),
        message: model.logStateMessage ?? model.localized("desktop.activity.service_no_logs"),
        symbol: "doc.text"
      )
    case .error:
      logNotice(
        title: model.localized("desktop.activity.could_not_load"),
        message: model.logStateMessage ?? model.localized("desktop.activity.showing_loaded_logs"),
        symbol: "exclamationmark.triangle",
        actionTitle: model.localized("desktop.common.try_again"),
        action: model.refreshSelectedLogSource
      )
    case .unavailable:
      logNotice(
        title: model.localized("desktop.activity.log_unavailable"),
        message: model.logStateMessage ?? model.localized("desktop.activity.choose_log_source"),
        symbol: "questionmark.folder"
      )
    }
  }

  private func logNotice(
    title: String,
    message: String,
    symbol: String,
    actionTitle: String? = nil,
    action: (() -> Void)? = nil
  ) -> some View {
    LabeledContent {
      if let actionTitle, let action {
        Button(actionTitle, action: action)
          .help(actionTitle)
      }
    } label: {
      Label {
        VStack(alignment: .leading, spacing: 2) {
          Text(title)
          Text(message)
            .foregroundStyle(.secondary)
        }
      } icon: {
        Image(systemName: symbol)
      }
    }
    .accessibilityIdentifier("activity.logs.\(model.logState.rawValue)")
    .listRowInsets(rowInsets)
  }

  private var filteredActivity: [DesignActivity] {
    let query = searchQuery.trimmingCharacters(in: .whitespacesAndNewlines)
    let categoryFiltered = model.activity.filter { selectedCategory.matches($0) }
    guard !query.isEmpty else { return categoryFiltered }
    return categoryFiltered.filter {
      [$0.time, $0.localizedTitle(using: model), $0.localizedDetail(using: model)]
        .contains { $0.localizedCaseInsensitiveContains(query) }
    }
  }

  private var filteredLogLines: [String] {
    let query = searchQuery.trimmingCharacters(in: .whitespacesAndNewlines)
    guard !query.isEmpty else { return model.liveLogLines }
    return model.liveLogLines.filter { $0.localizedCaseInsensitiveContains(query) }
  }
}

/// Bezel log well. System mono and label colors. Fills the pane height (the
/// enclosing `DesignGroupedPane` is opened with `fillHeight: true`) so Live
/// Logs no longer floats with empty space below. The historical crash from
/// filling the window with an NSTextView is now guarded by the coordinator's
/// `lastText` check — `apply` returns early when the text is unchanged, so a
/// scroll-to-end cannot re-enter `updateNSView` and loop.
private struct ActivityLogViewer: NSViewRepresentable {
  let lines: [String]
  let placeholder: String?

  func makeNSView(context: Context) -> NSScrollView {
    let scrollView = NSTextView.scrollableTextView()
    scrollView.hasVerticalScroller = true
    scrollView.autohidesScrollers = true
    scrollView.borderType = .bezelBorder
    scrollView.setAccessibilityIdentifier("activity.logs")
    if let textView = scrollView.documentView as? NSTextView {
      textView.isEditable = false
      textView.isSelectable = true
      textView.isRichText = false
      textView.drawsBackground = true
      textView.backgroundColor = .textBackgroundColor
      textView.textColor = .labelColor
      textView.font = .monospacedSystemFont(ofSize: NSFont.smallSystemFontSize, weight: .regular)
      textView.textContainerInset = NSSize(width: 8, height: 8)
      textView.textContainer?.widthTracksTextView = true
      textView.minSize = .zero
      textView.maxSize = NSSize(
        width: CGFloat.greatestFiniteMagnitude, height: CGFloat.greatestFiniteMagnitude)
      textView.isVerticallyResizable = true
      textView.isHorizontallyResizable = false
      textView.autoresizingMask = [.width]
    }
    context.coordinator.apply(lines: lines, placeholder: placeholder, in: scrollView)
    return scrollView
  }

  func updateNSView(_ scrollView: NSScrollView, context: Context) {
    context.coordinator.apply(lines: lines, placeholder: placeholder, in: scrollView)
  }

  func makeCoordinator() -> Coordinator { Coordinator() }

  final class Coordinator {
    private var lastText = ""

    func apply(lines: [String], placeholder: String?, in scrollView: NSScrollView) {
      guard let textView = scrollView.documentView as? NSTextView else { return }
      let font = NSFont.monospacedSystemFont(ofSize: NSFont.smallSystemFontSize, weight: .regular)
      let text: String
      let color: NSColor
      if lines.isEmpty, let placeholder {
        text = placeholder
        color = .secondaryLabelColor
      } else {
        text = lines.joined(separator: "\n")
        color = .labelColor
      }
      guard text != lastText else { return }
      lastText = text
      let visible = scrollView.documentVisibleRect
      let contentHeight =
        (scrollView.documentView?.bounds.height ?? visible.maxY) - visible.height
      let wasAtBottom = visible.minY >= contentHeight - 4
      textView.textStorage?.setAttributedString(
        NSAttributedString(
          string: text,
          attributes: [
            .font: font,
            .foregroundColor: color,
          ]))
      if lines.isEmpty {
        scrollView.contentView.scroll(to: .zero)
        scrollView.reflectScrolledClipView(scrollView.contentView)
      } else if wasAtBottom {
        textView.scrollToEndOfDocument(nil)
      }
    }
  }
}

