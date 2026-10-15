import Foundation

/// Compiles fixture Hub routes the same way core does: one catalog identity
/// is a credential choice; the same model id in two catalogs is an overlap.
enum DesignHubRouting {
  static func isEligible(_ account: DesignAccount) -> Bool {
    account.kind == .saved || account.id == "openrouter"
  }

  static func warning(for account: DesignAccount) -> String? {
    account.id == "personal-builder" ? "Catalog unavailable" : nil
  }

  static func defaultEnabledIDs(in accounts: [DesignAccount]) -> Set<String> {
    Set([
      "claude-work",
      "claude-personal",
      "claude-team",
      "codex-work",
      "google-pro",
      "grok-work",
      "openrouter",
      "personal-builder",
    ]).intersection(Set(accounts.map(\.id)))
  }

  static func sources(from accounts: [DesignAccount], enabledIDs: Set<String>) -> [DesignHubSource] {
    let eligible = accounts.filter(isEligible)
    var rows = eligible.map { account in
      DesignHubSource(
        id: account.id,
        name: account.name,
        detail: account.detail,
        provider: account.provider,
        providerID: account.providerID,
        symbol: account.symbol,
        enabled: enabledIDs.contains(account.id),
        warning: warning(for: account)
      )
    }
    // One hub-wide rotation row, the same shape the engine offers: the fixture
    // exercises the mode switch without inventing per-provider rows.
    rows.insert(
      DesignHubSource(
        id: "hub/default/rotation",
        name: "Rotate across accounts",
        detail: "Spread each model across the accounts that serve it",
        provider: "",
        symbol: "arrow.triangle.2.circlepath",
        enabled: enabledIDs.contains("hub/default/rotation"),
        rotates: true,
        rotatesAccountCount: eligible.count,
        hub: "default"
      ),
      at: 0
    )
    return rows
  }

  /// Fixture-only catalogs, keyed by fixture account id. Production never
  /// reaches here with real ids: ProductionModel overwrites hubCatalogs
  /// from snapshot HubCatalogs on every sync. Do not add production ids —
  /// real catalogs arrive from the engine (discovery cache/static policy).
  static func catalogs(from accounts: [DesignAccount]) -> [DesignHubCatalog] {
    accounts.filter(isEligible).compactMap { account in
      guard let models = fixtureModels(for: account.id), !models.isEmpty else { return nil }
      return DesignHubCatalog(
        accountID: account.id,
        catalogID: catalogID(for: account),
        models: models
      )
    }
  }

  static func compile(
    sources: [DesignHubSource],
    catalogs: [DesignHubCatalog],
    owners: [String: String]
  ) -> (
    sources: [DesignHubSource],
    models: [DesignPublishedModel],
    conflicts: [DesignRoutingConflict]
  ) {
    let sourceByID = Dictionary(uniqueKeysWithValues: sources.map { ($0.id, $0) })
    let publishingIDs = Set(
      sources.filter { $0.enabled && $0.warning == nil }.map(\.id)
    )
    let activeCatalogs = catalogs.filter { publishingIDs.contains($0.accountID) }

    var byModel: [String: [String: [String]]] = [:]
    for catalog in activeCatalogs {
      guard let source = sourceByID[catalog.accountID] else { continue }
      let pid = (source.providerID.isEmpty ? source.provider : source.providerID).lowercased()
      guard !pid.isEmpty else { continue }
      for model in catalog.models {
        var providersForModel = byModel[model] ?? [:]
        var accounts = providersForModel[pid] ?? []
        if !accounts.contains(catalog.accountID) {
          accounts.append(catalog.accountID)
        }
        providersForModel[pid] = accounts
        byModel[model] = providersForModel
      }
    }

    var published: [DesignPublishedModel] = []
    var overlapGroups: [String: (models: [String], accountIDs: [String])] = [:]

    for model in byModel.keys.sorted() {
      guard let providerGroups = byModel[model] else { continue }
      let allAccountIDs = providerGroups.values.flatMap { $0 }.sorted()
      if let owner = owners[model] {
        let cleanOwner = owner.hasPrefix("provider/") ? String(owner.dropFirst(9)).lowercased() : owner.lowercased()
        if let (matchedPid, accounts) = providerGroups.first(where: {
          $0.key == cleanOwner ||
          $0.value.contains(cleanOwner) ||
          $0.value.contains(where: { $0.hasSuffix("/" + cleanOwner) })
        }), let primaryAccount = accounts.first, let source = sourceByID[primaryAccount] {
          published.append(publishedModel(model, source: source))
          continue
        }
      }
      // Single provider offering this model: no routing conflict.
      // Multiple accounts within the same provider are pooled/failed over automatically.
      if providerGroups.count == 1, let (_, accounts) = providerGroups.first {
        if let primaryAccount = accounts.first, let source = sourceByID[primaryAccount] {
          published.append(publishedModel(model, source: source))
          continue
        }
      }
      // Cross-provider collision: 2 or more distinct providers offer this model.
      let key = "overlap|\(allAccountIDs.joined(separator: ","))"
      var group = overlapGroups[key] ?? ([], allAccountIDs)
      group.models.append(model)
      overlapGroups[key] = group
    }

    var conflicts: [DesignRoutingConflict] = []
    let overlapList = overlapGroups.values.sorted {
      $0.accountIDs.joined() < $1.accountIDs.joined()
    }
    for (index, group) in overlapList.enumerated() {
      let models = group.models.sorted()
      let candidates = candidates(
        group.accountIDs,
        sources: sourceByID,
        actionPrefix: "overlap-\(index + 1)"
      )
      conflicts.append(
        DesignRoutingConflict(
          id: "hub-conflict-\(index + 1)",
          kind: .modelOverlap,
          title: models.count == 1 ? models[0] : "\(models.count) Models",
          detail: modelSummary(models),
          models: models,
          needsAttention: true,
          candidates: candidates
        )
      )
    }

    let resolved = sources.map { source -> DesignHubSource in
      var next = source
      if let catalog = catalogs.first(where: { $0.accountID == source.id }),
         source.enabled, source.warning == nil {
        next.modelCount = catalog.models.count
      } else {
        next.modelCount = 0
      }
      return next
    }

    for conflict in conflicts {
      for model in conflict.models {
        published.append(
          DesignPublishedModel(
            modelID: model,
            ownerAccountID: nil,
            ownerName: "Needs a choice",
            ownerProvider: conflict.candidates.first?.provider ?? "",
            needsChoice: true
          )
        )
      }
    }

    return (
      resolved,
      published.sorted { $0.modelID.localizedStandardCompare($1.modelID) == .orderedAscending },
      conflicts
    )
  }

  static func modelSummary(_ models: [String]) -> String {
    guard let first = models.first else { return "No models" }
    if models.count == 1 { return first }
    if models.count == 2 { return "\(first) and \(models[1])" }
    return "\(models.count) models, including \(first)"
  }

  private static func publishedModel(_ model: String, source: DesignHubSource) -> DesignPublishedModel {
    DesignPublishedModel(
      modelID: model,
      ownerAccountID: source.id,
      ownerName: source.name,
      ownerProvider: source.provider,
      needsChoice: false
    )
  }

  static func routeCandidates(
    for modelID: String,
    catalogs: [DesignHubCatalog],
    sources: [DesignHubSource]
  ) -> [DesignRoutingCandidate] {
    allRouteCandidates(catalogs: catalogs, sources: sources)[modelID] ?? []
  }

  static func allRouteCandidates(
    catalogs: [DesignHubCatalog],
    sources: [DesignHubSource]
  ) -> [String: [DesignRoutingCandidate]] {
    let sourceByID = Dictionary(uniqueKeysWithValues: sources.map { ($0.id, $0) })
    let publishingIDs = Set(sources.filter { $0.enabled && $0.warning == nil }.map(\.id))
    let activeCatalogs = catalogs.filter { publishingIDs.contains($0.accountID) }

    var modelProviders: [String: [String: Set<String>]] = [:]
    for catalog in activeCatalogs {
      guard let source = sourceByID[catalog.accountID] else { continue }
      let pid = (source.providerID.isEmpty ? source.provider : source.providerID).lowercased()
      guard !pid.isEmpty else { continue }
      for model in catalog.models {
        modelProviders[model, default: [:]][pid, default: []].insert(catalog.accountID)
      }
    }

    var result: [String: [DesignRoutingCandidate]] = [:]
    for (modelID, byProvider) in modelProviders {
      guard byProvider.count > 1 else { continue }
      let pids = byProvider.keys.sorted()
      result[modelID] = pids.map { pid in
        let accounts = byProvider[pid] ?? []
        let n = accounts.count
        return DesignRoutingCandidate(
          id: "provider/\(pid)",
          label: hubProviderDisplayName(pid),
          detail: "\(n) \(n == 1 ? "account" : "accounts")",
          provider: pid,
          actionID: "model-route:\(modelID):provider/\(pid)",
          providerChoice: true
        )
      }
    }
    return result
  }

  static func candidates(
    _ accountIDs: [String],
    sources: [String: DesignHubSource],
    actionPrefix: String
  ) -> [DesignRoutingCandidate] {
    var out = accountIDs.compactMap { accountID -> DesignRoutingCandidate? in
      guard let source = sources[accountID] else { return nil }
      return DesignRoutingCandidate(
        id: source.id,
        label: source.name,
        detail: source.detail,
        provider: source.providerID.isEmpty ? source.provider : source.providerID,
        actionID: "\(actionPrefix):\(source.id)"
      )
    }
    // Provider-level choice, ahead of the accounts. Mirrors the engine's
    // hubRoutingCandidates: same ids, same actions, providers first.
    var byProvider: [String: [String]] = [:]
    for id in accountIDs {
      guard let source = sources[id] else { continue }
      let pid = source.providerID.isEmpty ? source.provider : source.providerID
      guard !pid.isEmpty else { continue }
      byProvider[pid, default: []].append(id)
    }
    if byProvider.count > 1 {
      let providers = byProvider.keys.sorted().map { pid -> DesignRoutingCandidate in
        let n = byProvider[pid]?.count ?? 0
        return DesignRoutingCandidate(
          id: "provider/\(pid)",
          label: hubProviderDisplayName(pid),
          detail: "\(n) \(n == 1 ? "account" : "accounts")",
          provider: pid,
          actionID: "\(actionPrefix):provider/\(pid)",
          providerChoice: true
        )
      }
      out.insert(contentsOf: providers, at: 0)
    }
    return out
  }

  private static func catalogID(for account: DesignAccount) -> String {
    switch account.provider.lowercased() {
    case "claude", "anthropic": return "claude"
    case "codex", "openai": return "codex"
    case "gemini", "google": return "gemini"
    case "grok", "xai": return "grok"
    case "kiro": return "kiro"
    case "openrouter": return "openrouter"
    default: return account.provider.lowercased()
    }
  }

  private static func displayName(forCatalog catalogID: String) -> String {
    switch catalogID {
    case "claude": return "Claude"
    case "codex": return "Codex"
    case "gemini": return "Gemini"
    case "grok": return "Grok"
    case "kiro": return "Kiro"
    case "openrouter": return "OpenRouter"
    default: return catalogID.capitalized
    }
  }

  private static func fixtureModels(for accountID: String) -> [String]? {
    switch accountID {
    case "claude-work":
      return claudeShared + ["claude-opus-4-1-thinking"]
    case "claude-personal":
      return claudeShared
    case "claude-team":
      return claudeShared + ["claude-3-5-sonnet-20241022"]
    case "codex-work":
      return codexShared + ["gpt-5.1-codex-spark"]
    case "codex-personal":
      return codexShared
    case "google-pro":
      return [
        "gemini-2.5-pro",
        "gemini-2.5-flash",
        "gemini-2.5-flash-lite",
        "gemini-2.0-flash",
        "gemini-1.5-pro",
      ]
    case "grok-work":
      return ["grok-3", "grok-3-mini", "grok-4", "grok-2", "grok-2-mini"]
    case "personal-builder":
      return ["kiro-auto", "kiro-sonnet"]
    case "openrouter":
      return [
        "openrouter/auto",
        "anthropic/claude-3.7-sonnet",
        "google/gemini-2.5-pro",
        "meta-llama/llama-3.3-70b-instruct",
        "qwen/qwen3-coder",
        "mistralai/mistral-large",
        "deepseek/deepseek-chat",
        "claude-sonnet-4",
        "claude-haiku-4-5",
        "gpt-5.1-codex",
        "grok-3",
      ]
    default:
      return nil
    }
  }

  private static let claudeShared = [
    "claude-opus-4-1",
    "claude-opus-4",
    "claude-sonnet-4",
    "claude-sonnet-4-5",
    "claude-haiku-4-5",
    "claude-3-7-sonnet-latest",
    "claude-3-5-sonnet-latest",
    "claude-3-5-haiku-latest",
    "claude-3-opus-latest",
    "claude-3-haiku-20240307",
  ]

  private static let codexShared = [
    "gpt-5.1-codex",
    "gpt-5.1-codex-mini",
    "gpt-5.1-codex-max",
    "GPT-5.6 Codex",
    "o3",
    "o4-mini",
    "o3-mini",
    "gpt-4.1",
    "gpt-4.1-mini",
  ]
}


/// Row selection for the Hub's source list. Accounts sharing a provider
/// stay adjacent (alphabetical inside each provider group) so a many-account
/// hub reads as provider blocks, not confetti. The hub-wide rotation row is
/// NOT here — rotation is hub policy, rendered once in the global strategy
/// section via rotationRows(in:). Rotation never hides a source — which
/// accounts a model spreads across is decided per request by the engine.
enum DesignHubSourceRows {
  static func visible(_ sources: [DesignHubSource]) -> [DesignHubSource] {
    sources.filter { !$0.rotates }.sorted { lhs, rhs in
      if lhs.provider != rhs.provider {
        return lhs.provider.localizedStandardCompare(rhs.provider) == .orderedAscending
      }
      return lhs.name.localizedStandardCompare(rhs.name) == .orderedAscending
    }
  }

  /// Hub-wide rotation rows (one per hub) for the global strategy section.
  static func rotationRows(in sources: [DesignHubSource]) -> [DesignHubSource] {
    sources.filter(\.rotates)
  }
}

/// Returns SF Symbol for a provider ID or provider brand name.
func providerSymbol(_ provider: String) -> String {
  DesignBrandAsset.fallbackSymbol(for: provider)
}

func hubProviderDisplayName(_ provider: String) -> String {
  switch provider.trimmingCharacters(in: .whitespacesAndNewlines).lowercased() {
  case "claude", "anthropic", "claude-code": return "Claude"
  case "codex": return "Codex"
  case "openai": return "OpenAI"
  case "gemini", "google": return "Gemini"
  case "grok", "xai": return "Grok"
  case "openrouter": return "OpenRouter"
  case "kiro": return "Kiro"
  case "workbuddy", "codebuddy": return "WorkBuddy"
  case "cline": return "Cline"
  case "cloudflare": return "Cloudflare"
  default:
    let native = nativeProviderName(provider)
    return native.isEmpty ? provider.capitalized : native
  }
}

/// Formats model conflict title and human-friendly subtitle explaining which
/// providers offer the models, replacing ambiguous "2 Models" or duplicate names.
@MainActor
func hubConflictDisplayInfo(
  _ conflict: DesignRoutingConflict,
  using model: MacOSDesignModel
) -> (title: String, subtitle: String) {
  let title: String
  if conflict.models.isEmpty {
    title = cleanModelDisplayName(conflict.title)
  } else if conflict.models.count <= 2 {
    title = conflict.models.map { cleanModelDisplayName($0) }.joined(separator: ", ")
  } else {
    title = model.localized(
      "desktop.hub.conflict_many_need_provider",
      count: conflict.models.count,
      replacing: [
        "first": cleanModelDisplayName(conflict.models[0]),
        "second": cleanModelDisplayName(conflict.models[1]),
        "more": String(conflict.models.count - 2),
      ]
    )
  }

  let providerCandidates = conflict.candidates.filter(\.providerChoice)
  let providers: [String]
  if !providerCandidates.isEmpty {
    providers = providerCandidates.map { hubProviderDisplayName($0.provider) }
  } else {
    let unique = Set(conflict.candidates.map { hubProviderDisplayName($0.provider) }.filter { !$0.isEmpty })
    providers = unique.sorted()
  }

  let subtitle: String
  if !providers.isEmpty {
    subtitle = model.localized(
      "desktop.hub.available_via",
      replacing: ["providers": providers.joined(separator: ", ")]
    )
  } else {
    subtitle = model.localized("desktop.published.multi_route_detail")
  }

  return (title, subtitle)
}

/// Formats candidate labels in conflict resolution pickers. A provider choice
/// displays the clean provider name without confusing account details.
func hubConflictCandidateLabel(_ candidate: DesignRoutingCandidate) -> String {
  hubProviderDisplayName(candidate.provider)
}

/// Resolves the currently active routing candidate ID for a published model.
func activeCandidateID(for item: DesignPublishedModel, candidates: [DesignRoutingCandidate]) -> String? {
  // 1. Match candidate by ownerProvider directly
  let providerToMatch = item.ownerProvider.trimmingCharacters(in: .whitespacesAndNewlines).lowercased()
  if !providerToMatch.isEmpty {
    if let match = candidates.first(where: {
      $0.provider.lowercased() == providerToMatch ||
      $0.id.lowercased() == "provider/\(providerToMatch)"
    }) {
      return match.id
    }
  }

  // 2. Match candidate if ownerAccountID contains the provider name
  if let ownerID = item.ownerAccountID?.lowercased() {
    if let match = candidates.first(where: {
      let candProvider = $0.provider.lowercased()
      return !candProvider.isEmpty && ownerID.contains(candProvider)
    }) {
      return match.id
    }
  }

  // 3. Direct ID match
  if let ownerID = item.ownerAccountID {
    if let direct = candidates.first(where: { $0.id == ownerID || ownerID.contains($0.id) }) {
      return direct.id
    }
  }

  // 4. Any provider choice matching candidate.provider
  if let providerCand = candidates.first(where: {
    $0.providerChoice && $0.provider.caseInsensitiveCompare(item.ownerProvider) == .orderedSame
  }) {
    return providerCand.id
  }

  // 5. Prefer candidate matching the model's native vendor identity
  let parsed = parseModelIdentity(item.modelID, fallbackProvider: item.ownerProvider)
  if !parsed.vendorKey.isEmpty {
    if let match = candidates.first(where: {
      $0.provider.lowercased() == parsed.vendorKey.lowercased() ||
      $0.id.lowercased() == "provider/\(parsed.vendorKey.lowercased())"
    }) {
      return match.id
    }
  }

  return candidates.first?.id
}

/// Deduplicates provider candidates by lowercase provider ID, preserving sorted order.
func uniqueProviderCandidates(_ candidates: [DesignRoutingCandidate]) -> [DesignRoutingCandidate] {
  let providerCandidates = candidates.filter(\.providerChoice)
  var unique: [String: DesignRoutingCandidate] = [:]
  for cand in providerCandidates {
    let pid = cand.provider.lowercased()
    if unique[pid] == nil {
      unique[pid] = cand
    }
  }
  return unique.keys.sorted().compactMap { unique[$0] }
}
