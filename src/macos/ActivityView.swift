import AppKit
import SwiftUI

enum ActivityCategory: String, CaseIterable, Identifiable {
  case all = "All Events"
  case routing = "Routing"
  case accounts = "Accounts & APIs"
  case proxies = "Proxy Hub"
  case issues = "Issues"

  var id: String { rawValue }

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
      let lower = "\(item.title) \(item.detail)".lowercased()
      return lower.contains("uses") || lower.contains("routing") || lower.contains("switched") || lower.contains("route")
    case .accounts:
      let lower = "\(item.title) \(item.detail)".lowercased()
      return lower.contains("account") || lower.contains("login") || lower.contains("gateway") || lower.contains("backup")
    case .proxies:
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
    .designConfirmation($confirmation)
  }

  /// One question, two subjects: the pane's segmented control decides whether
  /// the user is looking at logs or at events, and both clear the same store.
  private func requestClear() {
    confirmation = DesignConfirmation(
      id: "clear-activity",
      title: model.activityShowsLogs ? "Clear Visible Logs?" : "Clear Visible Events?",
      message: "Accounts, apps, and proxies are unchanged.",
      action: .confirm("Clear") { model.clearActivity() }
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
            "Log Source",
            selection: Binding(
              get: { model.selectedLogSourceID },
              set: { model.selectLogSource($0) }
            )
          ) {
            if model.logSources.isEmpty {
              Text("No Sources").tag("")
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
          Label("Filter Logs", systemImage: "line.3.horizontal.decrease")
        }
        .labelStyle(.iconOnly)
        .help("Filter logs by provider")
        .disabled(model.logSources.isEmpty)
        .accessibilityIdentifier("activity.logs.filter")
      } else {
        Menu {
          Picker("Category", selection: $selectedCategory) {
            ForEach(ActivityCategory.allCases) { cat in
              Text(cat.rawValue).tag(cat)
            }
          }
          .pickerStyle(.inline)
        } label: {
          Label(
            "Filter Events",
            systemImage: selectedCategory == .all
              ? "line.3.horizontal.decrease"
              : "line.3.horizontal.decrease.circle.fill"
          )
        }
        .labelStyle(.iconOnly)
        .help("Filter events by category")
        .accessibilityIdentifier("activity.logs.filter")
      }
    }
    ToolbarItem(placement: .primaryAction) {
      DesignToolbarSearch(
        text: $searchQuery,
        prompt: model.activityShowsLogs ? "Search logs" : "Search events"
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
                  ? "Changes to accounts and app settings will appear here."
                  : "No \(selectedCategory.rawValue.lowercased()) match your filter.")
              : "No events match your search."
          )
        } else {
          eventsWell(height: contentHeight)
        }
      } footer: {
        if model.activityShowsLogs {
          Text("Sensitive values are redacted before logs reach this window.")
        }
      }
    }
  }

  private var activityActions: some View {
    DesignPaneActions {
      if model.activityShowsLogs {
        DesignSheetButton(
          title: "Clear Log…",
          enabled: !filteredLogLines.isEmpty,
          destructive: true,
          identifier: "activity.clear-log"
        ) { requestClear() }
      } else {
        DesignSheetButton(
          title: "Clear Events…",
          enabled: !filteredActivity.isEmpty,
          destructive: true,
          identifier: "activity.clear-events"
        ) { requestClear() }
      }
    }
  }

  private var paneHeader: some View {
    Text("Recent changes and recovery information")
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
    Picker("View", selection: $model.activityShowsLogs) {
      Text("Events").tag(false)
      Text("Live Logs").tag(true)
    }
    .pickerStyle(.segmented)
    .labelsHidden()
    .controlSize(.regular)
    .accessibilityLabel("Activity view")
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
    HStack(alignment: .center, spacing: 10) {
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
          Text(item.title)
            .fontWeight(.medium)
            .lineLimit(1)
        }
        if !item.detail.isEmpty {
          Text(item.detail)
            .font(.caption)
            .foregroundStyle(.secondary)
            .lineLimit(2)
        }
      }
    }
    .listRowInsets(rowInsets)
    .contextMenu {
      Button("Copy Message") {
        if model.pasteString(item.title) {
          model.announceOnly("Copied activity message.")
        } else {
          model.announceOnly("Couldn’t copy activity message.")
        }
      }
      .help("Copy only the activity message.")
      Button("Copy Full Details") {
        if model.pasteString("\(item.day) \(item.time): \(item.title) - \(item.detail)") {
          model.announceOnly("Copied activity details.")
        } else {
          model.announceOnly("Couldn’t copy activity details.")
        }
      }
      .help("Copy the timestamp, message, and details.")
    }
    .accessibilityElement(children: .combine)
    .accessibilityLabel(activityAccessibilityLabel(for: item))
    .accessibilityIdentifier("activity.event.\(item.id)")
  }

  private var eventSections: [(key: String, items: [DesignActivity])] {
    var sections: [(String, [DesignActivity])] = []
    for item in filteredActivity {
      if sections.last?.0 == item.day {
        sections[sections.count - 1].1.append(item)
      } else {
        sections.append((item.day, [item]))
      }
    }
    return sections.map { (key: $0.0, items: $0.1) }
  }

  @ViewBuilder
  private func logsRows(height: CGFloat) -> some View {
    if model.logState == .ready {
      LabeledContent("Status", value: "Live")
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
      return "No log lines match your search."
    }
    switch model.logState {
    case .loading: return "Loading logs…"
    case .stopped: return "Proxy is not running — start it to stream new entries."
    case .empty: return "No log entries yet."
    case .error: return "Couldn’t load logs."
    case .unavailable: return "No log source available."
    case .idle, .ready: return "Output appears here while the selected provider is running."
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
        Text(model.logStateMessage ?? "Loading logs…")
          .foregroundStyle(.secondary)
      }
      .accessibilityIdentifier("activity.logs.loading")
      .listRowInsets(rowInsets)
    case .empty:
      logNotice(
        title: "No Logs Yet",
        message: model.logStateMessage ?? "The service has not written any log entries.",
        symbol: "doc.text"
      )
    case .error:
      logNotice(
        title: "Couldn’t Load Logs",
        message: model.logStateMessage ?? "Showing the most recent logs that loaded successfully.",
        symbol: "exclamationmark.triangle",
        actionTitle: "Try Again",
        action: model.refreshSelectedLogSource
      )
    case .unavailable:
      logNotice(
        title: "Selected Log Is No Longer Available",
        message: model.logStateMessage ?? "Choose another service or return to Activity.",
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
      [$0.time, $0.title, $0.detail].contains { $0.localizedCaseInsensitiveContains(query) }
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

