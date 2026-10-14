import AppKit
import SwiftUI

private enum AccountProviderFilter: Hashable {
  case all
  case provider(String)
}

struct AccountsView: View {
  @ObservedObject var model: MacOSDesignModel
  @State private var activeSheet: AccountsSheet?
  @State private var filter: AccountProviderFilter = .all
  @State private var searchQuery = ""
  @State private var editingAccount: DesignAccount?
  @State private var connectingGateway: DesignAccount?
  @State private var confirmation: DesignConfirmation?
  @State private var consumedInitialFlow = false

  init(model: MacOSDesignModel) {
    self.model = model
  }

  private var providers: [String] {
    let names = Set(model.accounts.map(\.provider))
    return names.sorted { lhs, rhs in
      let lhsPriority = nativeProviderPriority(lhs)
      let rhsPriority = nativeProviderPriority(rhs)
      if lhsPriority != rhsPriority { return lhsPriority < rhsPriority }
      return lhs.localizedStandardCompare(rhs) == .orderedAscending
    }
  }

  private var savedAccounts: [DesignAccount] {
    let filtered =
      switch filter {
      case .all:
        model.accounts.filter { $0.kind == .saved }
      case .provider(let provider):
        model.accounts.filter { $0.kind == .saved && $0.provider == provider }
      }
    return searched(filtered).sorted(by: nativeAccountOrder)
  }

  private var gateways: [DesignAccount] {
    let filtered =
      switch filter {
      case .all:
        model.accounts.filter { $0.kind == .gateway }
      case .provider(let provider):
        model.accounts.filter { $0.kind == .gateway && $0.provider == provider }
      }
    return searched(filtered).sorted(by: nativeAccountOrder)
  }

  var body: some View {
    Group {
      if model.accounts.isEmpty {
        DesignEmptyState(
          title: "No Accounts",
          message: "Add the login already on this Mac, sign in, or add an API gateway.",
          symbol: "person.badge.plus",
          actionTitle: "Add Login…",
          actionIdentifier: "accounts.empty.add-login",
          action: { activeSheet = .addAccount }
        )
      } else if savedAccounts.isEmpty && gateways.isEmpty {
        DesignEmptyState(
          title: "No Results",
          message: emptyFilterMessage,
          symbol: "magnifyingglass",
          actionTitle: hasActiveFilter ? "Clear Filters" : nil,
          action: hasActiveFilter ? clearFilters : nil
        )
      } else {
        inventory
      }
    }
    .background {
      Group {
        Button("") { activeSheet = .addAccount }
          .keyboardShortcut("n", modifiers: .command)
        Button("") { activeSheet = .addGateway }
          .keyboardShortcut("n", modifiers: [.command, .shift])
      }
      .opacity(0)
      .allowsHitTesting(false)
    }
    .toolbar {
      ToolbarItem(placement: .primaryAction) {
        HStack(spacing: 8) {
          if providers.count > 1 {
            providerPicker
          }
          DesignToolbarSearch(text: $searchQuery, prompt: "Search Accounts")
            .frame(minWidth: 160, idealWidth: 180, maxWidth: 220)
        }
      }
    }
    .sheet(item: $activeSheet, onDismiss: consumeStartupFlow) { sheet in
      switch sheet {
      case .addAccount: AddSavedAccountSheet(model: model)
      case .addGateway: AddGatewaySheet(model: model)
      }
    }
    .sheet(item: $editingAccount) { account in
      EditAccountSheet(model: model, accountID: account.id)
    }
    .sheet(item: $connectingGateway) { gateway in
      ConnectGatewaySheet(model: model, gatewayID: gateway.id)
    }
    .onChange(of: model.pendingGatewayConnectID) { _, id in
      guard let id, let gateway = model.accounts.first(where: { $0.id == id }) else { return }
      model.pendingGatewayConnectID = nil
      connectingGateway = gateway
    }
    .designConfirmation($confirmation, onDismiss: consumeStartupFlow)
    .onChange(of: model.addLoginRequested) { _, requested in
      if requested { consumeAddLoginRequest() }
    }
    .onAppear {
      consumeAddLoginRequest()
      guard !consumedInitialFlow, let flow = model.pendingStartupFlow else { return }
      consumedInitialFlow = true
      // The Accounts pane is mounted inside NavigationSplitView/NavigationStack.
      // Defer the first sheet presentation until that host has completed its
      // first layout pass; setting a sheet item during construction is ignored
      // by AppKit and leaves the fixture looking as if the flow did nothing.
      DispatchQueue.main.asyncAfter(deadline: .now() + 0.25) {
        guard model.pendingStartupFlow == flow else { return }
        switch flow {
        case "add-account", "add-account-error": activeSheet = .addAccount
        case "add-gateway", "add-gateway-error": activeSheet = .addGateway
        case "remove-account":
          if let account = model.accounts.first(where: { $0.kind == .saved }) {
            requestRemoval(of: account)
          }
        default: break
        }
      }
    }
  }

  private var paneActions: some View {
    DesignPaneActions {
      // No key equivalent: the pane already binds ⌘N (see the hidden buttons
      // in the body), and a Return binding would make any keystroke in the
      // pane add an account.
      DesignSheetButton(
        title: "Add Login…",
        enabled: !model.isBusy,
        identifier: "accounts.save-login"
      ) { activeSheet = .addAccount }
      DesignSheetButton(
        title: "Add API Gateway…",
        enabled: canAddGateway(
          isBusy: model.isBusy,
          gatewayProviderCount: model.gatewayProviderOptions.count
        ),
        identifier: "accounts.add-gateway"
      ) { activeSheet = .addGateway }
    }
  }

  /// Opens the Add sheet for a request made elsewhere. Deferred for the same
  /// reason as the startup flow below, and long enough for the Welcome sheet
  /// to finish closing: AppKit drops a sheet presented while another is still
  /// animating out of the same window.
  private func consumeAddLoginRequest() {
    guard model.addLoginRequested else { return }
    DispatchQueue.main.asyncAfter(deadline: .now() + 0.35) {
      guard model.addLoginRequested else { return }
      model.addLoginRequested = false
      if activeSheet == nil { activeSheet = .addAccount }
    }
  }

  private func consumeStartupFlow() {
    switch model.pendingStartupFlow {
    case "add-account", "add-account-error", "add-gateway", "add-gateway-error", "remove-account":
      model.pendingStartupFlow = nil
    default: break
    }
  }

  private func requestRemoval(of account: DesignAccount) {
    confirmation = DesignConfirmation(
      id: "remove-account",
      title: "Remove “\(account.name)” from AnyPick?",
      message: removalMessage(for: account),
      action: .confirm("Remove") { model.removeAccount(id: account.id) }
    )
  }

  private var inventory: some View {
    DesignGroupedPane(contentIdentifier: "accounts.list", actions: { paneActions }) {
      if !savedAccounts.isEmpty || (filter == .all && gateways.isEmpty) {
        Section {
          if savedAccounts.isEmpty {
            // A group with no rows states it in one grey line: the pane-level
            // empty state is the filling hero above, and a second one nested in
            // a Section grows a card it was never meant to have.
            DesignEmptyRow(text: emptyFilterMessage)
          } else {
            ForEach(savedAccounts) { account in
              AccountListRow(
                model: model,
                account: account,
                allAccounts: model.accounts,
                onEdit: { editingAccount = $0 },
                onConnect: { connectingGateway = $0 },
                onRemove: { requestRemoval(of: $0) }
              )
            }
          }
        } header: {
          Text(savedAccounts.isEmpty ? "Accounts" : "Accounts (\(savedAccounts.count))")
        }
      }

      if !gateways.isEmpty || (filter == .all && !model.gatewayProviderOptions.isEmpty) {
        Section {
          if gateways.isEmpty {
            // Same one-grey-line treatment as the Accounts group above:
            // the add command lives once in the pane action row below.
            DesignEmptyRow(text: gatewayEmptyMessage)
          } else {
            ForEach(gateways) { gateway in
              AccountListRow(
                model: model,
                account: gateway,
                allAccounts: model.accounts,
                onEdit: { editingAccount = $0 },
                onConnect: { connectingGateway = $0 },
                onRemove: { requestRemoval(of: $0) }
              )
            }
          }
        } header: {
          Text(gateways.isEmpty ? "API Gateways" : "API Gateways (\(gateways.count))")
        }
      }
    }
    .onChange(of: providers) { _, names in
      if case .provider(let provider) = filter, !names.contains(provider) {
        filter = .all
      }
    }
  }
}

private struct AccountListRow: View {
  @ObservedObject var model: MacOSDesignModel
  let account: DesignAccount
  let allAccounts: [DesignAccount]
  let onEdit: (DesignAccount) -> Void
  let onConnect: (DesignAccount) -> Void
  let onRemove: (DesignAccount) -> Void

  /// Hover reveals the row's primary command in its own column; the row's
  /// context menu and accessibility actions offer the same command without it.
  @State private var isHovered = false

  var body: some View {
    let canMakeCurrent = account.kind == .saved && !model.isCurrentAccount(account)
    let isCurrent = model.isCurrentAccount(account)
    let displayName = disambiguatedAccountName(for: account, in: allAccounts)
    let subtitle = accountRowSubtitle(for: account, title: displayName)
    let showsAction = account.kind == .saved
      ? canMakeCurrent
      : account.status != .unavailable

    return DesignIdentityRow(
      title: displayName,
      detail: subtitle,
      issue: accountIssue(account)
    ) {
      DesignProviderIcon(provider: account.provider, fallbackSymbol: account.symbol, size: 28)
    } trailing: {
      AccountRowTrailing(
        model: model,
        account: account,
        displayName: displayName,
        isCurrent: isCurrent,
        showsAction: showsAction,
        isHovered: isHovered,
        onEdit: { onEdit(account) },
        onConnect: { onConnect(account) },
        onRemove: { onRemove(account) }
      )
    }
    .contentShape(Rectangle())
    .onTapGesture {
      model.pendingAccountDetailID = account.id
    }
    .onHover { hovering in
      isHovered = hovering
    }
    .frame(maxWidth: .infinity, alignment: .leading)
    .accessibilityIdentifier("accounts.row.\(account.id)")
    .accessibilityLabel(accountAccessibilityLabel(for: account, in: allAccounts))
    .contextMenu {
      if canMakeCurrent {
        Button("Switch to Account") { model.makeAccountCurrent(id: account.id) }
          .help("Make this saved login current for compatible apps.")
          .disabled(model.isBusy)
      }
      if account.kind == .gateway {
        Button("Connect") { onConnect(account) }
          .help("Connect this API gateway to AnyPick.")
          .disabled(model.isBusy || account.status == .unavailable)
      }
      Button("Show Details") { model.pendingAccountDetailID = account.id }
        .help("View this account’s identity, usage, and connection details.")
      Button("Edit…") { onEdit(account) }
        .help("Change this account’s name or saved configuration.")
      Button(account.kind == .gateway ? "Test Connection" : "Refresh Login") {
        if account.kind == .gateway {
          model.testSavedGateway(id: account.id)
        } else {
          model.refreshAccount(id: account.id)
        }
      }
      .help(account.kind == .gateway ? "Check whether this API gateway is reachable." : "Refresh the saved login from its provider.")
      .disabled(model.isBusy)
      Divider()
      Button("Remove…", role: .destructive) { onRemove(account) }
        .help("Remove this saved login from AnyPick.")
    }
    .modifier(
      AccountRowAccessibilityActions(
        showsSwitch: canMakeCurrent,
        showsConnect: account.kind == .gateway,
        onSwitch: { model.makeAccountCurrent(id: account.id) },
        onConnect: { onConnect(account) }
      )
    )
  }

  private func accountRowSubtitle(for account: DesignAccount, title: String) -> String {
    let cleanDetail = account.detail.trimmingCharacters(in: .whitespacesAndNewlines)
    let identity: String
    if !cleanDetail.isEmpty {
      let resolved = cleanSourceDisplayName(cleanDetail)
      identity = resolved.caseInsensitiveCompare(account.provider) != .orderedSame ? resolved : ""
    } else if let live = model.liveLogins.first(where: {
      ($0.providerID.caseInsensitiveCompare(account.providerID) == .orderedSame || $0.providerName.caseInsensitiveCompare(account.provider) == .orderedSame)
        && ($0.identity?.isEmpty == false)
    }), let liveIdentity = live.identity?.trimmingCharacters(in: .whitespacesAndNewlines), !liveIdentity.isEmpty {
      identity = liveIdentity
    } else {
      identity = ""
    }

    if account.kind == .gateway {
      return identity.isEmpty ? "API Gateway" : identity
    }

    if !identity.isEmpty {
      return "\(account.provider) · \(identity)"
    }
    return "\(account.provider) · Saved login"
  }

  private func accountIssue(_ account: DesignAccount) -> String? {
    switch account.status {
    case .attention, .unavailable:
      return account.status.rawValue
    case .ready, .running, .stopped:
      return nil
    }
  }
}

/// The trailing three columns of one account row: the primary command, the
/// row's state, and the row menu.
///
/// It is a type of its own so the columns can be measured. The property that
/// matters is that the grid is the same for every row — including a row with
/// nothing in a column — and the only way to keep that true through later edits
/// is to assert the width, not to look at it.
struct AccountRowTrailing: View {
  @ObservedObject var model: MacOSDesignModel
  let account: DesignAccount
  let displayName: String
  let isCurrent: Bool
  let showsAction: Bool
  let isHovered: Bool
  let onEdit: () -> Void
  let onConnect: () -> Void
  let onRemove: () -> Void

  /// Column widths. The action column is the widest control it can hold
  /// ("Connect"), the marker column holds one SF Symbol, and the chevron
  /// column holds the drill-in disclosure.
  static let actionColumnWidth: CGFloat = 72
  static let statusColumnWidth: CGFloat = 18
  static let chevronColumnWidth: CGFloat = 14

  private var revealsAction: Bool {
    showsAction && (isHovered || model.switchingAccountID == account.id)
  }

  var body: some View {
    HStack(spacing: 8) {
      // Column 1 — the primary command, revealed on hover. The column holds its
      // width when the cell is empty, which is what keeps every row's Switch /
      // Connect, marker and menu in the same three columns.
      ReservedColumn(width: Self.actionColumnWidth) {
        if revealsAction {
          actionButton
        }
      }
      .accessibilityHidden(!revealsAction)

      // Column 2 — the row's state: current, attention, unavailable, or empty.
      ReservedColumn(width: Self.statusColumnWidth) {
        statusIcon
      }

      // Column 3 — the row's commands.
      moreMenu

      // Column 4 — drill-in disclosure. Every row opens its detail on tap,
      // and a System Settings row that drills in always says so.
      ReservedColumn(width: Self.chevronColumnWidth) {
        Image(systemName: "chevron.right")
          .font(.system(size: 12, weight: .medium))
          .foregroundStyle(.tertiary)
          .accessibilityHidden(true)
      }
    }
    .fixedSize()
  }

  @ViewBuilder
  private var statusIcon: some View {
    if isCurrent {
      Image(systemName: "checkmark.circle.fill")
        .foregroundStyle(.green)
        .accessibilityLabel("Current")
        .help("Current active account on this Mac")
    }
  }

  private var switching: Bool { model.switchingAccountID == account.id }

  private var actionButton: some View {
    Button {
      if account.kind == .saved {
        model.makeAccountCurrent(id: account.id)
      } else {
        onConnect()
      }
    } label: {
      ZStack {
        Text(account.kind == .saved ? "Switch" : "Connect")
          .opacity(switching ? 0 : 1)
        if switching {
          ProgressView().controlSize(.small)
        }
      }
      .frame(maxWidth: .infinity)
    }
    .buttonStyle(.bordered)
    .controlSize(.small)
    .disabled(model.isBusy)
    .help(account.kind == .saved ? "Make this saved login current for compatible apps." : "Connect to this saved API gateway.")
    .accessibilityIdentifier(
      account.kind == .saved ? "accounts.switch.\(account.id)" : "accounts.connect.\(account.id)"
    )
    .accessibilityLabel(
      account.kind == .saved ? "Switch to \(displayName)" : "Connect to \(displayName)"
    )
  }

  /// The row's secondary commands, in a system `Menu` rather than a hand-built
  /// NSButton + NSMenu: the control, its hit area and its keyboard behaviour
  /// are the platform's. It offers the same commands as the row's context menu,
  /// minus the primary one that already has its own button.
  private var moreMenu: some View {
    DesignMoreActionsMenu(
      label: "More actions for \(displayName)",
      identifier: "accounts.more.\(account.id)"
    ) {
      Button("Show Details") { model.pendingAccountDetailID = account.id }
        .help("View this account’s identity, usage, and connection details.")
      Button("Edit…") { onEdit() }
        .help("Change this account’s name or saved configuration.")
      Button(account.kind == .gateway ? "Test Connection" : "Refresh Login") {
        if account.kind == .gateway {
          model.testSavedGateway(id: account.id)
        } else {
          model.refreshAccount(id: account.id)
        }
      }
      .help(account.kind == .gateway ? "Check whether this API gateway is reachable." : "Refresh the saved login from its provider.")
      .disabled(model.isBusy)
      Divider()
      Button("Remove…", role: .destructive) { onRemove() }
        .help("Remove this saved login from AnyPick.")
    }
    .fixedSize()
    .opacity(isHovered ? 1.0 : 0.0)
    .animation(.easeInOut(duration: 0.15), value: isHovered)
  }
}

extension AccountsView {

  private var providerPicker: some View {
    Picker("Provider", selection: $filter) {
      Text("All Providers").tag(AccountProviderFilter.all)
      Divider()
      ForEach(providers, id: \.self) { provider in
        Label(provider, systemImage: DesignBrandAsset.fallbackSymbol(for: provider))
          .tag(AccountProviderFilter.provider(provider))
      }
    }
    .pickerStyle(.menu)
    .labelsHidden()
    .accessibilityIdentifier("accounts.filter")
  }

  private func removalMessage(for account: DesignAccount) -> String {
    if account.kind == .gateway {
      return "Only “\(account.name)” is removed from AnyPick. The remote API key is not revoked."
    }
    let app = anypickDisplayName(account.provider)
    if model.isCurrentAccount(account) {
      return "“\(account.name)” is removed from AnyPick. \(app) stays signed in on this Mac."
    }
    return "“\(account.name)” is removed from AnyPick. The \(app) login on this Mac does not change."
  }

  private var hasActiveFilter: Bool {
    !searchQuery.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty
      || filter != .all
  }

  private func clearFilters() {
    searchQuery = ""
    filter = .all
  }

  private var gatewayEmptyMessage: String {
    if !searchQuery.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty {
      return "No gateways match \(searchQuery)\"."
    }
    return "No API gateways yet."
  }

  private var emptyFilterMessage: String {
    if !searchQuery.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty {
      return "No accounts match \"\(searchQuery)\"."
    }
    if case .provider(let provider) = filter {
      return "No \(provider) accounts."
    }
    return "No accounts match this filter."
  }

  private func searched(_ accounts: [DesignAccount]) -> [DesignAccount] {
    let query = searchQuery.trimmingCharacters(in: .whitespacesAndNewlines)
    guard !query.isEmpty else { return accounts }
    return accounts.filter {
      [$0.name, $0.detail, $0.provider, $0.kind.rawValue]
        .contains { $0.localizedCaseInsensitiveContains(query) }
    }
  }

  private func nativeAccountOrder(_ lhs: DesignAccount, _ rhs: DesignAccount) -> Bool {
    if lhs.kind != rhs.kind { return lhs.kind == .saved }
    let lhsIndex = nativeProviderPriority(lhs.provider)
    let rhsIndex = nativeProviderPriority(rhs.provider)
    if lhsIndex != rhsIndex { return lhsIndex < rhsIndex }
    return lhs.name.localizedStandardCompare(rhs.name) == .orderedAscending
  }
}

private struct AccountRowAccessibilityActions: ViewModifier {
  let showsSwitch: Bool
  let showsConnect: Bool
  let onSwitch: () -> Void
  let onConnect: () -> Void

  func body(content: Content) -> some View {
    if showsSwitch {
      content.accessibilityAction(named: "Switch", onSwitch)
    } else if showsConnect {
      content.accessibilityAction(named: "Connect", onConnect)
    } else {
      content
    }
  }
}
