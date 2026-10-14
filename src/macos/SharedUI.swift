import AppKit
import SwiftUI

extension View {
  /// Fixture `--appearance` only. `.system` must not call `preferredColorScheme`
  /// — passing `nil` still blocks the window from tracking macOS Light/Dark.
  @ViewBuilder
  func followingDesignAppearance(_ appearance: DesignAppearance) -> some View {
    if let scheme = appearance.colorScheme {
      preferredColorScheme(scheme)
    } else {
      self
    }
  }
}

extension DesignApp {
  /// Copy shown when an app has no working login; `nil` keeps the row clean.
  var issue: String? {
    if !isAppRouteConfigured(self) {
      return "No login chosen. Open the app to choose one."
    }
    switch status {
    case .attention, .unavailable:
      return "This app doesn’t have a working login."
    case .ready, .running, .stopped:
      return nil
    }
  }
}

struct DesignStatusLabel: View {
  let status: DesignStatus

  var body: some View {
    HStack(spacing: 5) {
      statusDot
      Text(status.rawValue)
        .foregroundStyle(.secondary)
    }
    .accessibilityLabel("Status: \(status.rawValue)")
  }

  @ViewBuilder
  private var statusDot: some View {
    switch status {
    case .running, .ready:
      Circle()
        .fill(Color.green)
        .frame(width: 7, height: 7)
    case .attention:
      Circle()
        .fill(Color.orange)
        .frame(width: 7, height: 7)
    case .unavailable:
      Circle()
        .fill(Color.red)
        .frame(width: 7, height: 7)
    case .stopped:
      Circle()
        .strokeBorder(Color.secondary.opacity(0.6), lineWidth: 1.5)
        .frame(width: 7, height: 7)
    }
  }
}

/// Provider-reported usage for one window: the system progress indicator, the
/// percentage, and the reset instant when the vendor reports one.
///
/// This was a hand-built capsule with fixed pixel widths, a hand-picked track
/// opacity and its own threshold colours. `ProgressView` is the control System
/// Settings uses, it follows the accent, Increase Contrast and Reduce Motion,
/// and it needs no recipe of its own. The threshold tint stays because a
/// nearly-exhausted quota is attention, and `.red` / `.orange` are system
/// colours rather than palette values.
struct DesignQuotaView: View {
  let window: DesignUsageWindow
  var isCompact: Bool = false
  var showsLabel: Bool = true

  private var remainingPercent: Int { max(0, min(100, window.remainingPercent)) }

  var body: some View {
    HStack(spacing: 8) {
      if showsLabel {
        Text(quotaWindowLabel(window))
          .foregroundStyle(.secondary)
          .lineLimit(1)
      }

      ProgressView(value: Double(remainingPercent), total: 100)
        .frame(width: isCompact ? 64 : 110)
        .tint(attentionTint)
        .accessibilityHidden(true)

      Text("\(remainingPercent)%")
        .monospacedDigit()
        .foregroundStyle(.secondary)
        .frame(width: 42, alignment: .trailing)

      Text(
        quotaResetFormatted(
          resetsAtMs: window.resetsAtMs,
          limitWindowSeconds: window.limitWindowSeconds
        ) ?? ""
      )
      .foregroundStyle(.secondary)
      .lineLimit(1)
      .frame(width: 72, alignment: .trailing)
    }
    .accessibilityElement(children: .combine)
    .accessibilityLabel("\(quotaWindowLabel(window)): \(remainingPercent)% remaining")
  }

  private var attentionTint: Color? {
    if remainingPercent <= 5 { return .red }
    if remainingPercent <= 20 { return .orange }
    return nil
  }
}

/// System warning glyph. Multicolor is the Battery / Wi‑Fi treatment —
/// do not paint `.yellow` over it.
struct DesignWarningSymbol: View {
  var scale: Image.Scale = .small

  var body: some View {
    Image(systemName: "exclamationmark.triangle.fill")
      .symbolRenderingMode(.multicolor)
      .imageScale(scale)
  }
}

/// Settings list identity: title, then a caption. Issues use the Battery
/// warning line — triangle + copy under the title, not beside the chevron.
struct DesignIdentityRow<Icon: View, Trailing: View, Subcontent: View>: View {
  let title: String
  let detail: String
  var issue: String? = nil
  var metadata: String? = nil
  @ViewBuilder var icon: () -> Icon
  @ViewBuilder var subcontent: () -> Subcontent
  @ViewBuilder var trailing: () -> Trailing

  init(
    title: String,
    detail: String,
    issue: String? = nil,
    metadata: String? = nil,
    @ViewBuilder icon: @escaping () -> Icon,
    @ViewBuilder subcontent: @escaping () -> Subcontent,
    @ViewBuilder trailing: @escaping () -> Trailing
  ) {
    self.title = title
    self.detail = detail
    self.issue = issue
    self.metadata = metadata
    self.icon = icon
    self.subcontent = subcontent
    self.trailing = trailing
  }

  init(
    title: String,
    detail: String,
    issue: String? = nil,
    metadata: String? = nil,
    @ViewBuilder icon: @escaping () -> Icon,
    @ViewBuilder trailing: @escaping () -> Trailing
  ) where Subcontent == EmptyView {
    self.init(
      title: title,
      detail: detail,
      issue: issue,
      metadata: metadata,
      icon: icon,
      subcontent: { EmptyView() },
      trailing: trailing
    )
  }

  var body: some View {
    HStack(spacing: 12) {
      Label {
        VStack(alignment: .leading, spacing: 2) {
          Text(title)
          if !detail.isEmpty {
            Text(detail)
              .font(.subheadline)
              .foregroundStyle(.secondary)
              .lineLimit(1)
          }
          if let metadata, !metadata.isEmpty {
            Text(metadata)
              .font(.caption)
              .foregroundStyle(.secondary)
              .lineLimit(1)
          }
          subcontent()
          if let issue {
            HStack(alignment: .firstTextBaseline, spacing: 4) {
              DesignWarningSymbol()
              Text(issue)
                .fixedSize(horizontal: false, vertical: true)
            }
            .font(.subheadline)
            .foregroundStyle(.secondary)
            .accessibilityElement(children: .combine)
            .accessibilityLabel(issue)
          }
        }
        // Accounts & APIs' inventory row sizes its text block with
        // `maxWidth: .infinity` and pins the trailing cluster with
        // `.fixedSize()`. A bare `Spacer` only expands when something above it
        // already promised the width, so rows built on this helper stayed at
        // their intrinsic width and did not reach the right edge when the
        // window widened — the same content looked narrower here than in
        // Accounts. Match that row's geometry so every destination fills alike.
        .frame(maxWidth: .infinity, alignment: .leading)
      } icon: {
        icon()
      }
      Spacer(minLength: 8)
      trailing()
        .fixedSize()
    }
  }
}

extension DesignIdentityRow where Trailing == EmptyView, Subcontent == EmptyView {
  init(
    title: String,
    detail: String,
    issue: String? = nil,
    metadata: String? = nil,
    @ViewBuilder icon: @escaping () -> Icon
  ) {
    self.init(
      title: title,
      detail: detail,
      issue: issue,
      metadata: metadata,
      icon: icon,
      subcontent: { EmptyView() },
      trailing: { EmptyView() }
    )
  }
}

struct DesignEmptyState: View {
  let title: String
  let message: String
  let symbol: String
  var actionTitle: String?
  var actionIdentifier: String?
  var action: (() -> Void)?

  var body: some View {
    ContentUnavailableView {
      Label(title, systemImage: symbol)
    } description: {
      Text(message)
    } actions: {
      if let actionTitle, let action {
        Button(actionTitle, action: action)
          .help(message)
          .modifier(DesignOptionalAccessibilityIdentifier(identifier: actionIdentifier))
      }
    }
    .frame(maxWidth: .infinity, maxHeight: .infinity)
  }
}

/// A row-level copy command with one brief success state everywhere.
///
/// The copy glyph stays fixed so the action column does not move when the
/// pasteboard write succeeds; tint and the accessible label carry the feedback.
struct DesignCopyButton: View {
  let copied: Bool
  let label: String
  let identifier: String
  let action: () -> Void

  private var copiedDescription: String {
    label.hasPrefix("Copy ")
      ? "Copied \(label.dropFirst("Copy ".count))"
      : "Copied"
  }

  var body: some View {
    Button(action: action) {
      DesignCopyGlyph(copied: copied)
    }
    .buttonStyle(.borderless)
    .controlSize(.small)
    .help(copied ? copiedDescription : label)
    .accessibilityLabel(copied ? copiedDescription : label)
    .accessibilityIdentifier(identifier)
  }
}

struct DesignCopyGlyph: View {
  let copied: Bool

  var body: some View {
    Image(systemName: "doc.on.doc")
      .foregroundStyle(copied ? .green : .secondary)
  }
}

/// A borderless SF Symbol button for a secondary row action.
struct DesignIconButton: View {
  let symbol: String
  let label: String
  let identifier: String
  let isDisabled: Bool
  let action: () -> Void

  init(
    symbol: String,
    label: String,
    identifier: String,
    isDisabled: Bool = false,
    action: @escaping () -> Void
  ) {
    self.symbol = symbol
    self.label = label
    self.identifier = identifier
    self.isDisabled = isDisabled
    self.action = action
  }

  var body: some View {
    Button(action: action) {
      Image(systemName: symbol)
        .foregroundStyle(.secondary)
    }
    .buttonStyle(.borderless)
    .controlSize(.small)
    .help(label)
    .accessibilityLabel(label)
    .accessibilityIdentifier(identifier)
    .disabled(isDisabled)
  }
}

/// Standard ellipsis menu trigger for row-level secondary actions.
struct DesignMoreActionsMenu<Content: View>: View {
  let label: String
  let identifier: String
  let isDisabled: Bool
  @ViewBuilder private var content: () -> Content

  init(
    label: String,
    identifier: String,
    isDisabled: Bool = false,
    @ViewBuilder content: @escaping () -> Content
  ) {
    self.label = label
    self.identifier = identifier
    self.isDisabled = isDisabled
    self.content = content
  }

  var body: some View {
    Menu {
      content()
    } label: {
      Image(systemName: "ellipsis")
        .accessibilityHidden(true)
    }
    .menuStyle(.borderlessButton)
    .menuIndicator(.hidden)
    .controlSize(.small)
    .help(label)
    .accessibilityLabel(label)
    .accessibilityIdentifier(identifier)
    .disabled(isDisabled)
  }
}

/// One cell of a fixed trailing column grid: the column keeps its width even
/// when the cell has no content.
///
/// `Group { if … { … } }.frame(width:)` does *not* reserve the width — SwiftUI
/// flattens a `Group` whose content is `EmptyView`, and a frame applied to
/// `EmptyView` is dropped — so rows with an empty cell moved left and the
/// trailing controls stopped lining up. A real container fixes the size, which
/// is what makes "the column exists whether or not this row fills it" true.
struct ReservedColumn<Content: View>: View {
  let width: CGFloat
  @ViewBuilder var content: () -> Content

  var body: some View {
    ZStack(alignment: .trailing) {
      content()
    }
    .frame(width: width, alignment: .trailing)
  }
}

/// One grey line inside a group that has no rows, the way System Settings
/// states an empty list.
///
/// It is deliberately not `ContentUnavailableView`: that is the *pane's* empty
/// state (icon, title, description, one action) and belongs to the pane body,
/// not to a group inside a populated one. Before this existed, four panes said
/// "nothing here" four different ways — a filling hero, an icon+text stack, a
/// plain secondary line, and a labelled row — so the same situation looked
/// different on every screen.
struct DesignEmptyRow: View {
  let text: String

  var body: some View {
    Text(text)
      .foregroundStyle(.secondary)
      .multilineTextAlignment(.center)
      .frame(maxWidth: .infinity, alignment: .center)
      .accessibilityIdentifier("state.empty-row")
  }
}

struct DesignLoadingState: View {
  var body: some View {
    ProgressView("Loading AnyPick…")
      .controlSize(.large)
      .frame(maxWidth: .infinity, maxHeight: .infinity)
      .accessibilityIdentifier("state.loading")
  }
}

/// Grouped Form shared by every pane. Pane actions are rendered in a plain
/// action row below the Form, like the action rows in System Settings —
/// never in a second inset container, section footer, or toolbar.
///
/// Action controls must be `DesignSheetButton` (NSButton). SwiftUI `Button`
/// under `.searchable` is copied into the window toolbar on macOS 26.
struct DesignGroupedPane<Content: View>: View {
  @ViewBuilder var content: () -> Content
  private let actions: AnyView?
  private let contentIdentifier: String?
  /// Kept for source compatibility with panes that explicitly opt into a
  /// filling layout. Regular panes remain content-sized so the action row
  /// follows the last group instead of being pushed to the window edge.
  var fillHeight: Bool = false

  init(
    fillHeight: Bool = false,
    contentIdentifier: String? = nil,
    @ViewBuilder content: @escaping () -> Content
  ) {
    self.fillHeight = fillHeight
    self.content = content
    self.actions = nil
    self.contentIdentifier = contentIdentifier
  }

  init<ActionContent: View>(
    fillHeight: Bool = false,
    contentIdentifier: String? = nil,
    @ViewBuilder actions: @escaping () -> ActionContent,
    @ViewBuilder content: @escaping () -> Content
  ) {
    self.fillHeight = fillHeight
    self.content = content
    self.actions = AnyView(actions())
    self.contentIdentifier = contentIdentifier
  }

  var body: some View {
    if fillHeight {
      VStack(spacing: 0) {
        groupedForm
          .frame(maxWidth: .infinity, maxHeight: .infinity, alignment: .top)
        actionRow
      }
      .frame(maxWidth: .infinity, maxHeight: .infinity, alignment: .top)
    } else {
      ScrollView {
        VStack(spacing: 0) {
          groupedForm
            .fixedSize(horizontal: false, vertical: true)
            .frame(maxWidth: .infinity)
          actionRow
        }
        .frame(maxWidth: .infinity, alignment: .top)
      }
      .frame(maxWidth: .infinity, maxHeight: .infinity, alignment: .top)
    }
  }

  private var groupedForm: some View {
    Form {
      content()
    }
    .formStyle(.grouped)
    .modifier(DesignOptionalAccessibilityIdentifier(identifier: contentIdentifier))
  }

  @ViewBuilder
  private var actionRow: some View {
    if let actions {
      actions
        .frame(maxWidth: .infinity, alignment: .trailing)
        .padding(.horizontal)
        .padding(.vertical, 8)
    }
  }
}

private struct DesignOptionalAccessibilityIdentifier: ViewModifier {
  let identifier: String?

  @ViewBuilder
  func body(content: Content) -> some View {
    if let identifier {
      content.accessibilityIdentifier(identifier)
    } else {
      content
    }
  }
}

/// Plain trailing action row directly below the grouped Form, matching the
/// action placement used by System Settings for pane-level commands without
/// adding another inset background around the buttons.
struct DesignPaneActions<Content: View>: View {
  @ViewBuilder var content: () -> Content

  var body: some View {
    // Keep the native trailing action row at normal widths, but do not let
    // pane commands clip when the detail column becomes narrow. ViewThatFits
    // selects the system-styled stacked fallback without introducing a
    // custom flow layout or a second container around the controls.
    ViewThatFits(in: .horizontal) {
      HStack(spacing: 12) {
        Spacer(minLength: 0)
        content()
      }
      VStack(alignment: .trailing, spacing: 8) {
        content()
      }
    }
  }
}

/// Native toolbar search. `.searchable` on macOS 26 lifts descendant SwiftUI
/// `Button`s into the titlebar, which is how Add Account appeared twice.
struct DesignToolbarSearch: NSViewRepresentable {
  @Binding var text: String
  var prompt: String

  func makeCoordinator() -> Coordinator { Coordinator(text: $text) }

  func makeNSView(context: Context) -> NSSearchField {
    let field = NSSearchField()
    field.placeholderString = prompt
    field.delegate = context.coordinator
    field.target = context.coordinator
    field.action = #selector(Coordinator.changed(_:))
    field.sendsSearchStringImmediately = true
    field.sendsWholeSearchString = false
    field.controlSize = .regular
    return field
  }

  func updateNSView(_ field: NSSearchField, context: Context) {
    context.coordinator.text = $text
    if field.stringValue != text { field.stringValue = text }
    field.placeholderString = prompt
  }

  final class Coordinator: NSObject, NSSearchFieldDelegate {
    var text: Binding<String>
    init(text: Binding<String>) { self.text = text }

    @objc func changed(_ sender: NSSearchField) {
      text.wrappedValue = sender.stringValue
    }

    func controlTextDidChange(_ obj: Notification) {
      guard let field = obj.object as? NSSearchField else { return }
      text.wrappedValue = field.stringValue
    }
  }
}

/// AppKit push buttons for native sheet actions, not SwiftUI `.bordered`.
///
/// A sheet's primary action sets `keyEquivalent` to Return, which makes AppKit
/// treat it as the window's default button and draw the accent fill, the
/// pressed state, the disabled bezel, and Increase Contrast itself. Overriding
/// `bezelColor` / `contentTintColor` to fake that fill is what stopped the
/// primary button from matching the system button beside it.
struct DesignSheetButton: NSViewRepresentable {
  var title: String
  var help: String? = nil
  var keyEquivalent: String = ""
  var enabled = true
  var destructive = false
  var identifier: String? = nil
  var action: () -> Void

  func makeCoordinator() -> Coordinator {
    Coordinator(action: action)
  }

  func makeNSView(context: Context) -> NSButton {
    let button = NSButton(
      title: title,
      target: context.coordinator,
      action: #selector(Coordinator.click)
    )
    button.bezelStyle = .rounded
    button.controlSize = .regular
    button.setButtonType(.momentaryPushIn)
    button.toolTip = help ?? title
    button.keyEquivalent = keyEquivalent
    button.isEnabled = enabled
    button.hasDestructiveAction = destructive
    if let identifier {
      button.setAccessibilityIdentifier(identifier)
    }
    button.setContentHuggingPriority(.required, for: .horizontal)
    button.setContentCompressionResistancePriority(.required, for: .horizontal)
    return button
  }

  func updateNSView(_ button: NSButton, context: Context) {
    button.title = title
    button.toolTip = help ?? title
    button.keyEquivalent = keyEquivalent
    button.isEnabled = enabled
    button.hasDestructiveAction = destructive
    if let identifier {
      button.setAccessibilityIdentifier(identifier)
    }
    context.coordinator.action = action
  }

  final class Coordinator: NSObject {
    var action: () -> Void
    init(action: @escaping () -> Void) { self.action = action }
    @objc func click() { action() }
  }
}

/// Native macOS sheet host. Like a System Settings sheet, there is no
/// titlebar: the title sits inside the sheet above the content, and the
/// actions live in a separated bottom bar rather than the window title bar.
struct DesignSheetHost<Content: View>: View {
  let title: String
  var width: CGFloat = 480
  var primaryTitle: String
  var primaryDisabled = false
  var primaryIdentifier: String?
  var primaryRole: ButtonRole? = nil
  var showsCancel = true
  var cancelTitle = "Cancel"
  var primaryHelp: String? = nil
  var cancelHelp: String? = nil
  var onCancel: () -> Void
  var onPrimary: () -> Void
  @ViewBuilder var content: () -> Content

  var body: some View {
    VStack(spacing: 0) {
      VStack(alignment: .leading, spacing: 18) {
        Text(title)
          .font(.title2.weight(.semibold))
          .frame(maxWidth: .infinity, alignment: .leading)
          .padding(.horizontal)
          .accessibilityAddTraits(.isHeader)

        ScrollView {
          content()
            .formStyle(.grouped)
            .scrollContentBackground(.hidden)
            .frame(maxWidth: .infinity)
            .frame(maxWidth: .infinity, alignment: .topLeading)
            .fixedSize(horizontal: false, vertical: true)
        }
        // Keep short states content-sized while retaining a cap for long
        // provider feedback. The outer scroll view owns overflow; content
        // must not force the sheet past this cap or overlap the action bar.
        .background(Color.clear)
        .scrollIndicators(.automatic)
        .frame(maxWidth: .infinity, minHeight: 80, maxHeight: 560, alignment: .top)
      }
      .padding(.vertical)

      // No drawn hairline above the buttons: a native sheet separates the
      // action bar by spacing, not by a rule this view paints itself.
      HStack(spacing: 8) {
        Spacer(minLength: 0)
        if showsCancel {
          DesignSheetButton(
            title: cancelTitle,
            help: cancelHelp ?? "Close this sheet without saving changes.",
            keyEquivalent: "\u{1b}",
            identifier: "sheet.cancel",
            action: onCancel
          )
          .fixedSize()
        }
        DesignSheetButton(
          title: primaryTitle,
          help: primaryHelp ?? primaryTitle,
          keyEquivalent: "\r",
          enabled: !primaryDisabled,
          destructive: primaryRole == .destructive,
          identifier: primaryIdentifier ?? "sheet.primary",
          action: onPrimary
        )
        .fixedSize()
      }
      .padding()
    }
    .background(Color(nsColor: .windowBackgroundColor))
    .frame(minWidth: 320, idealWidth: width, maxWidth: 600)
    .fixedSize(horizontal: false, vertical: true)
  }
}

// MARK: - Confirmation

/// One pending confirmation: the question, one sentence about its consequence,
/// and the buttons that can answer it.
///
/// Every irreversible command in the app builds one of these and hands it to
/// `designConfirmation(_:onDismiss:)`, so a confirmation is the same alert
/// everywhere and the rules below are stated once instead of seventeen times.
struct DesignConfirmation: Identifiable {
  /// A button that answers the dialog. `destructive` marks the one that
  /// discards something; a confirmation that offers two ways forward (Skip /
  /// Replace) leaves it false on the harmless choice.
  struct Action: Identifiable {
    let title: String
    var destructive: Bool
    var identifier: String?
    let perform: () -> Void

    var id: String { title }

    /// The common shape: one button that does the thing, with Cancel beside
    /// it. `destructive` defaults to true because a question is only worth
    /// asking when answering it destroys something.
    ///
    /// Keep `title` short. A macOS alert gives its buttons one 228pt row
    /// beside Cancel; a title that does not fit is not squeezed, it is pushed
    /// onto its own full-width row — which is what put "Remove Account" and
    /// "Cancel" on two lines. Measured on `_NSAlertPanel`: 12 characters fit
    /// ("Forget Books") and 13 do not ("Remove Login"), and the split is pixel
    /// width, not length — "Remove Guest" (12) wraps while "Forget Books" (12)
    /// does not. The alert title already names the command ("Remove “Claude”
    /// from AnyPick?"), so the button only has to be the verb.
    static func confirm(
      _ title: String,
      destructive: Bool = true,
      identifier: String? = nil,
      perform: @escaping () -> Void
    ) -> Action {
      Action(
        title: title,
        destructive: destructive,
        identifier: identifier,
        perform: perform
      )
    }
  }

  /// Distinct per command, so a pending request survives the body recomputes
  /// that the id would otherwise blur together.
  let id: String
  let title: String
  let message: String
  /// In reading order. Cancel is appended by the host, so a caller cannot
  /// forget it or put it in the wrong place.
  let actions: [Action]

  init(id: String, title: String, message: String, actions: [Action]) {
    self.id = id
    self.title = title
    self.message = message
    self.actions = actions
  }

  init(id: String, title: String, message: String, action: Action) {
    self.init(id: id, title: title, message: message, actions: [action])
  }
}

extension View {
  /// Hosts the pane's confirmation. Exactly one per view: SwiftUI only
  /// reliably presents the most recently attached alert, so a view that offers
  /// several confirmations keeps a single request in state and points it at
  /// whichever command asked.
  ///
  /// `pending` is cleared by every dismissal — the confirming button, Cancel or
  /// Escape — and `onDismiss` runs there, which is where a cold-start flow has
  /// to be marked consumed.
  func designConfirmation(
    _ pending: Binding<DesignConfirmation?>,
    onDismiss: @escaping () -> Void = {}
  ) -> some View {
    modifier(DesignConfirmationHost(pending: pending, onDismiss: onDismiss))
  }
}

private struct DesignConfirmationHost: ViewModifier {
  @Binding var pending: DesignConfirmation?
  let onDismiss: () -> Void

  func body(content: Content) -> some View {
    content.alert(
      pending?.title ?? "",
      isPresented: Binding(
        get: { pending != nil },
        set: { presented in
          guard !presented else { return }
          pending = nil
          onDismiss()
        }
      ),
      presenting: pending
    ) { request in
      // Cancel is spelled out last on purpose: the platform gives the default
      // key to the last button, and the dismissing choice must own it.
      switch request.actions.count {
      case 0:
        Button("Cancel", role: .cancel, action: {})
          .help("Dismiss this confirmation.")
      case 1:
        answerButton(request.actions[0])
        Button("Cancel", role: .cancel, action: {})
          .help("Keep the current settings and close this confirmation.")
      default:
        // Three or more answers take one full-width row each. That is the
        // platform's own rule — measured on `_NSAlertPanel`, even "No / Yes /
        // Cancel" stacks — so the backup-overwrite dialog is the only place in
        // the app that does not answer on a single line, and it is the
        // platform's layout, not a choice made here.
        answerButton(request.actions[0])
        answerButton(request.actions[1])
        Button("Cancel", role: .cancel, action: {})
          .help("Keep the current settings and close this confirmation.")
      }
    } message: { request in
      Text(request.message)
    }
  }

  private func answerButton(_ action: DesignConfirmation.Action) -> some View {
    Button(action.title, role: action.destructive ? .destructive : nil, action: action.perform)
      .help(action.destructive ? "Confirm this change." : "Continue with this choice.")
      .modifier(DesignOptionalAccessibilityIdentifier(identifier: action.identifier))
  }
}
