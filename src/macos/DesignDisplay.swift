import Foundation

// Shared display and state helpers for macOS panes and the Quick Panel.
// Keeping these rules in one place prevents fixture and production from
// drifting on route identity, provider copy, and recovery behavior.

/// Canonical key for a route: provider family + account identity.
/// Two actions pointing at the same saved login (different engine IDs)
/// collapse to one row; the current route is never shown twice.
func routeDedupeKey(_ route: DesignRoute) -> String {
  let source = route.sourceID.lowercased().trimmingCharacters(in: .whitespacesAndNewlines)
  // The source is the account. A display key collapses two saved logins
  // that share a label and an empty identity into the one action id the
  // switcher can still invoke.
  if !source.isEmpty { return "source|\(source)" }
  let provider = (route.providerID ?? "").lowercased().trimmingCharacters(in: .whitespacesAndNewlines)
  let name = route.name.lowercased().trimmingCharacters(in: .whitespacesAndNewlines)
  let detail = route.detail.lowercased().trimmingCharacters(in: .whitespacesAndNewlines)
  return "\(provider)|\(name)|\(detail)"
}

/// Sort native first, then canonicalize/dedupe. When duplicates share a key,
/// the selected route wins so the current route appears exactly once.
func uniqueCompatibleRoutes(_ routes: [DesignRoute], selectedID: String?) -> [DesignRoute] {
  let sorted = nativeFirstRoutes(routes)
  var byKey: [String: DesignRoute] = [:]
  var order: [String] = []
  for route in sorted {
    let key = routeDedupeKey(route)
    if let existing = byKey[key] {
      if route.id == selectedID, existing.id != selectedID {
        byKey[key] = route
      }
      continue
    }
    byKey[key] = route
    order.append(key)
  }
  return order.compactMap { byKey[$0] }
}

/// Account + gateway routes for one app, deduped. Single source of truth
/// for the switcher, AppRouteSheet, and Quick Panel counts.
func compatibleAccountRoutes(in app: DesignApp) -> [DesignRoute] {
  uniqueCompatibleRoutes(
    app.routeOptions.filter { $0.kind == .account || $0.kind == .native },
    selectedID: app.selectedRouteID.isEmpty ? nil : app.selectedRouteID
  )
}

/// Join provider and identity without a dangling separator.
func accountIdentityLine(provider: String, detail: String) -> String {
  let cleanProvider = provider.trimmingCharacters(in: .whitespacesAndNewlines)
  let cleanDetail = detail.trimmingCharacters(in: .whitespacesAndNewlines)
  switch (cleanProvider.isEmpty, cleanDetail.isEmpty) {
  case (true, true): return ""
  case (true, false): return cleanDetail
  case (false, true): return cleanProvider
  case (false, false): return "\(cleanProvider) · \(cleanDetail)"
  }
}

/// Identity metadata comes from provider-owned credential stores. Keep only a
/// short printable value in the native UI; an unreadable value is represented
/// by the caller's generic "Current login" copy instead of rendering a token.
func displaySafeIdentity(_ raw: String) -> String? {
  let value = raw.trimmingCharacters(in: .whitespacesAndNewlines)
  guard !value.isEmpty, value.count <= 160 else { return nil }
  guard value.rangeOfCharacter(from: .controlCharacters) == nil else { return nil }
  guard !looksLikeOpaqueDisplayValue(value) else { return nil }
  return value
}

/// Operation messages are useful feedback, but they must not be allowed to
/// turn a provider response or credential into a giant SwiftUI Text view.
func displaySafeFeedback(_ raw: String, fallback: String) -> String {
  let value = raw.trimmingCharacters(in: .whitespacesAndNewlines)
  guard !value.isEmpty, value.count <= 512 else { return fallback }
  let punctuation = CharacterSet.punctuationCharacters
  for chunk in value.components(separatedBy: .whitespacesAndNewlines) {
    let candidate = chunk.trimmingCharacters(in: punctuation)
    if looksLikeOpaqueDisplayValue(candidate) { return fallback }
  }
  return value
}

private func looksLikeOpaqueDisplayValue(_ value: String) -> Bool {
  let parts = value.split(separator: ".")
  if parts.count == 3, parts.allSatisfy({ $0.count >= 8 }) {
    return true
  }
  guard value.unicodeScalars.count >= 48,
        !value.contains("@"),
        !value.contains(":"),
        !value.contains(" ") else { return false }
  let allowed = CharacterSet.alphanumerics.union(
    CharacterSet(charactersIn: "-_.+=/")
  )
  return value.unicodeScalars.allSatisfy { allowed.contains($0) }
}

/// Visible name for an account row or detail header.
/// Keeps the user's chosen account name clean without appending redundant
/// provider suffixes like "(OpenAI)" or "(Gemini)", since the provider icon
/// and subtitle already communicate provider identity.
func disambiguatedAccountName(for account: DesignAccount, in all: [DesignAccount]) -> String {
  let name = account.name.trimmingCharacters(in: .whitespacesAndNewlines)
  if !name.isEmpty { return name }
  let detail = account.detail.trimmingCharacters(in: .whitespacesAndNewlines)
  if !detail.isEmpty { return detail }
  return account.provider
}

/// VoiceOver label: account, provider, identity, plus position on collision.
func accountAccessibilityLabel(
  for account: DesignAccount,
  in all: [DesignAccount],
  positionLabel: (Int, Int) -> String = { "\($0) of \($1)" }
) -> String {
  let identity = accountIdentityLine(provider: account.provider, detail: account.detail)
  let base: String
  if identity.isEmpty || identity == account.name {
    base = "\(account.name), \(account.provider)"
  } else if account.name.isEmpty {
    base = identity
  } else {
    base = "\(account.name), \(identity)"
  }
  let sameName = all.filter {
    $0.name.caseInsensitiveCompare(account.name) == .orderedSame
  }.sorted {
    $0.id.localizedStandardCompare($1.id) == .orderedAscending
  }
  guard sameName.count > 1, let index = sameName.firstIndex(where: { $0.id == account.id }) else {
    return base
  }
  return "\(base) (\(positionLabel(index + 1, sameName.count)))"
}

/// Map a raw engine routeKind / detail to user-facing copy.
/// Never surfaces "direct-account", "account", or "provider/id proxy".
func friendlyRouteDetail(_ rawDetail: String?, routeKind: String?) -> String {
  let cleaned = (rawDetail ?? "").trimmingCharacters(in: .whitespacesAndNewlines)
  let rawKind = (routeKind ?? "").trimmingCharacters(in: .whitespacesAndNewlines)
  let looksInternal = cleaned.isEmpty
    || cleaned == rawKind
    || cleaned == "direct-account"
    || cleaned == "managed-account"
    || cleaned == "account"
    || cleaned == "pool"
  if !looksInternal { return cleaned }
  switch rawKind {
  case "direct-account": return "Direct account"
  case "managed-account": return "AnyPick proxy"
  case "account", "pool": return "Saved account"
  case "hub": return "Proxy Hub"
  case "gateway": return "API gateway"
  case "native": return "Direct account"
  default: return "Available route"
  }
}

@MainActor
func friendlyRouteDetail(
  _ rawDetail: String?,
  routeKind: String?,
  using model: MacOSDesignModel
) -> String {
  let cleaned = (rawDetail ?? "").trimmingCharacters(in: .whitespacesAndNewlines)
  let rawKind = (routeKind ?? "").trimmingCharacters(in: .whitespacesAndNewlines)
  let looksInternal = cleaned.isEmpty || cleaned == rawKind
    || ["direct-account", "managed-account", "account", "pool"].contains(cleaned)
  guard looksInternal else { return cleaned }
  let key: String
  switch rawKind {
  case "direct-account", "native": key = "desktop.common.direct_account"
  case "managed-account": key = "desktop.apps.anypick_proxy"
  case "account", "pool": key = "desktop.common.saved_account"
  case "hub": key = "desktop.nav.proxy_hub"
  case "gateway": key = "desktop.account_detail.api_gateway"
  default: key = "desktop.common.available_route"
  }
  return model.localized(key)
}

func friendlyRouteKindLabel(_ kind: DesignRouteKind) -> String {
  switch kind {
  case .native: return "Direct account"
  case .account: return "Saved account"
  case .hub: return "Proxy Hub"
  case .gateway: return "API gateway"
  }
}

@MainActor
func friendlyRouteKindLabel(_ kind: DesignRouteKind, using model: MacOSDesignModel) -> String {
  switch kind {
  case .native: model.localized("desktop.common.direct_account")
  case .account: model.localized("desktop.common.saved_account")
  case .hub: model.localized("desktop.nav.proxy_hub")
  case .gateway: model.localized("desktop.account_detail.api_gateway")
  }
}

/// Engine proxy labels can be "provider/internal-id proxy" or "<Provider> proxy · <Identity>".
/// Prefer the clean identity or friendly provider name so no composite ID reaches the UI.
func friendlyProxyName(label: String, providerId: String) -> String {
  let cleaned = label.trimmingCharacters(in: .whitespacesAndNewlines)
  if cleaned.contains("/") {
    return "\(nativeProviderName(providerId)) proxy"
  }
  if cleaned.isEmpty { return "\(nativeProviderName(providerId)) proxy" }
  for separator in [" · ", " • "] {
    if let range = cleaned.range(of: separator) {
      let suffix = String(cleaned[range.upperBound...]).trimmingCharacters(in: .whitespacesAndNewlines)
      if !suffix.isEmpty {
        return suffix
      }
    }
  }
  return cleaned
}

@MainActor
func friendlyProxyName(label: String, providerId: String, using model: MacOSDesignModel) -> String {
  let cleaned = label.trimmingCharacters(in: .whitespacesAndNewlines)
  if !cleaned.contains("/"), !cleaned.isEmpty {
    for separator in [" · ", " • "] {
      if let range = cleaned.range(of: separator) {
        let suffix = String(cleaned[range.upperBound...]).trimmingCharacters(in: .whitespacesAndNewlines)
        if !suffix.isEmpty { return suffix }
      }
    }
    return cleaned
  }
  return model.localized("desktop.proxies.proxy_named", replacing: [
    "provider": nativeProviderName(providerId),
  ])
}

/// E.g. "Running · Port 62252" instead of raw "http://127.0.0.1:62252", and "Stopped" instead of "stopped".
func friendlyProxyStatusSubtitle(status: DesignStatus, port: Int, detail: String) -> String {
  switch status {
  case .running:
    if port > 0 {
      return "Running · Port \(port)"
    }
    return "Running"
  case .stopped:
    return "Stopped"
  case .attention:
    return "Needs attention"
  case .unavailable:
    return "Unavailable"
  case .ready:
    return "Ready"
  }
}

@MainActor
func friendlyProxyStatusSubtitle(
  status: DesignStatus,
  port: Int,
  detail: String,
  using model: MacOSDesignModel
) -> String {
  if status == .running, port > 0 {
    return model.localized("desktop.proxies.running_port", replacing: ["port": String(port)])
  }
  return status.localizedLabel(using: model)
}

/// Parse a loopback service address to its port. URL parsing needs a
/// scheme, so schemeless "127.0.0.1:41401" falls
/// back to a host:port split. Bracketed IPv6 ("[::1]:5150") works too.
func servicePort(from address: String?) -> Int? {
  guard let address = address?.trimmingCharacters(in: .whitespacesAndNewlines),
    !address.isEmpty
  else { return nil }
  if let port = URL(string: address)?.port { return port }
  let hostPort: String
  if let schemeRange = address.range(of: "://") {
    hostPort = String(address[schemeRange.upperBound...])
  } else {
    hostPort = address
  }
  guard let colon = hostPort.range(of: ":", options: .backwards) else { return nil }
  let portText = String(hostPort[colon.upperBound...])
  guard !portText.isEmpty, !portText.contains("/") else { return nil }
  return Int(portText)
}

/// E.g. "anthropic/claude-sonnet-4" displays as "claude-sonnet-4".
func cleanModelDisplayName(_ raw: String) -> String {
  let trimmed = raw.trimmingCharacters(in: .whitespacesAndNewlines)
  guard !trimmed.isEmpty else { return "" }
  if trimmed == "Direct account" || trimmed == "Same as Default" { return trimmed }
  guard let slashIndex = trimmed.firstIndex(of: "/") else {
    return trimmed
  }
  let remainder = String(trimmed[trimmed.index(after: slashIndex)...]).trimmingCharacters(in: .whitespacesAndNewlines)
  if !remainder.isEmpty {
    return remainder
  }
  return trimmed
}

/// E.g. "openai/gpt-5" displays as "gpt-5".
func cleanSourceDisplayName(_ raw: String) -> String {
  let trimmed = raw.trimmingCharacters(in: .whitespacesAndNewlines)
  guard !trimmed.isEmpty else { return "" }
  guard let slashIndex = trimmed.lastIndex(of: "/") else {
    return trimmed
  }
  let remainder = String(trimmed[trimmed.index(after: slashIndex)...]).trimmingCharacters(in: .whitespacesAndNewlines)
  if !remainder.isEmpty {
    return remainder
  }
  return trimmed
}

/// Stable service-operation keys so ProxyHubView rows and ProductionModel
/// agree without string surgery.
func hubSourceServiceID(_ accountID: String) -> String { "hub-source/\(accountID)" }
func hubConflictServiceID(_ conflictID: String) -> String { "hub-conflict/\(conflictID)" }

/// Vendor window cadence as a duration noun (Usage): 18000 → "5 hours",
/// 604800 → "week". Data-driven only — nil when unknown. Callers prefix
/// "every"/"Every"; nothing here names a plan ("5-hour" is not a name the
/// payload gives us).
func usageWindowPeriod(limitWindowSeconds: Int?) -> String? {
  guard let seconds = limitWindowSeconds, seconds > 0 else { return nil }
  if seconds < 3600 {
    let mins = max(1, Int((Double(seconds) / 60).rounded()))
    return mins == 1 ? "1 minute" : "\(mins) minutes"
  }
  let hours = seconds / 3600
  if hours < 24 {
    return hours == 1 ? "1 hour" : "\(hours) hours"
  }
  let days = seconds / 86400
  if days == 1 { return "day" }
  if days == 7 { return "week" }
  if days % 7 == 0 { return "\(days / 7) weeks" }
  return "\(days) days"
}

/// Adjective for Antigravity limit captions: 604800 → "weekly", 18000 → "five hour".
func quotaLimitAdjective(limitWindowSeconds: Int?) -> String? {
  guard let seconds = limitWindowSeconds, seconds > 0 else { return nil }
  if seconds == 18000 { return "five hour" }
  if seconds == 604800 { return "weekly" }
  if seconds == 86400 { return "daily" }
  if seconds == 3600 { return "hourly" }
  return usageWindowPeriod(limitWindowSeconds: seconds)
}

/// Compact badge for a quota window: e.g. "5h", "Weekly", "Monthly", "Session".
/// Antigravity summary titles ("Weekly Limit Remaining") stay verbatim so the
/// detail rows match the vendor UI; Codex Primary/Secondary still collapse.
func quotaWindowLabel(_ window: DesignUsageWindow) -> String {
  let clean = window.label.trimmingCharacters(in: .whitespacesAndNewlines)
  if !["", "primary", "secondary", "5h", "weekly", "daily", "monthly", "session", "quota"].contains(clean.lowercased()) { return clean }
  if clean.localizedCaseInsensitiveContains("limit remaining") {
    return clean.isEmpty ? "Quota" : clean
  }
  if let seconds = window.limitWindowSeconds, seconds > 0 {
    if seconds == 18000 { return "5h" }
    if seconds == 3600 { return "1h" }
    if seconds == 86400 { return "Daily" }
    if seconds == 604800 { return "Weekly" }
    if seconds >= 2419200 && seconds <= 2678400 { return "Monthly" }
    let hours = seconds / 3600
    if hours > 0 && hours < 24 { return "\(hours)h" }
    let days = seconds / 86400
    if days > 0 && days < 7 { return "\(days)d" }
  }
  if clean.localizedCaseInsensitiveCompare("primary") == .orderedSame {
    return "5h"
  }
  if clean.localizedCaseInsensitiveCompare("secondary") == .orderedSame {
    return "Weekly"
  }
  return clean.isEmpty ? "Quota" : clean
}

/// Compact reset time/date string: e.g. "Oct 16", "in 2h", "in 45m".
func quotaResetFormatted(
  resetsAtMs: Double?,
  limitWindowSeconds: Int? = nil,
  now: Date = Date()
) -> String? {
  guard let ms = resetsAtMs, ms > 0 else {
    if let period = usageWindowPeriod(limitWindowSeconds: limitWindowSeconds) {
      return "every \(period)"
    }
    return nil
  }
  let targetDate = Date(timeIntervalSince1970: ms / 1000)
  let diff = targetDate.timeIntervalSince(now)
  if diff <= 0 {
    return "Resets soon"
  }
  if diff < 3600 {
    let mins = max(1, Int((diff / 60).rounded()))
    return "in \(mins)m"
  }
  if diff < 86400 {
    let hours = max(1, Int((diff / 3600).rounded()))
    return "in \(hours)h"
  }
  let formatter = DateFormatter()
  let calendar = Calendar.current
  let sameYear = calendar.component(.year, from: targetDate) == calendar.component(.year, from: now)
  formatter.dateFormat = sameYear ? "MMM d" : "MMM d, yyyy"
  return formatter.string(from: targetDate)
}

/// Antigravity-style reset copy: "fully refresh in 3 days, 19 hours".
/// Nil when there is no future reset instant.
func quotaFullyRefreshFormatted(resetsAtMs: Double?, now: Date = Date()) -> String? {
  guard let ms = resetsAtMs, ms > 0 else { return nil }
  let target = Date(timeIntervalSince1970: ms / 1000)
  let diff = target.timeIntervalSince(now)
  if diff <= 0 { return "fully refresh soon" }
  let totalHours = Int(diff / 3600)
  let days = totalHours / 24
  let hours = totalHours % 24
  if days > 0 && hours > 0 {
    let dayUnit = days == 1 ? "day" : "days"
    let hourUnit = hours == 1 ? "hour" : "hours"
    return "fully refresh in \(days) \(dayUnit), \(hours) \(hourUnit)"
  }
  if days > 0 {
    let dayUnit = days == 1 ? "day" : "days"
    return "fully refresh in \(days) \(dayUnit)"
  }
  if hours > 0 {
    let hourUnit = hours == 1 ? "hour" : "hours"
    return "fully refresh in \(hours) \(hourUnit)"
  }
  let mins = max(1, Int((diff / 60).rounded()))
  let minUnit = mins == 1 ? "minute" : "minutes"
  return "fully refresh in \(mins) \(minUnit)"
}

@MainActor
func localizedQuotaPeriod(limitWindowSeconds: Int?, using model: MacOSDesignModel) -> String? {
  guard let seconds = limitWindowSeconds, seconds > 0 else { return nil }
  if seconds < 3600 {
    let count = max(1, Int((Double(seconds) / 60).rounded()))
    return model.localized("desktop.quota.minutes", count: count, replacing: ["count": String(count)])
  }
  let hours = seconds / 3600
  if hours < 24 {
    return model.localized("desktop.quota.hours", count: hours, replacing: ["count": String(hours)])
  }
  let days = seconds / 86400
  if days == 1 { return model.localized("desktop.quota.day") }
  if days == 7 { return model.localized("desktop.quota.week") }
  if days % 7 == 0 {
    let weeks = days / 7
    return model.localized("desktop.quota.weeks", count: weeks, replacing: ["count": String(weeks)])
  }
  return model.localized("desktop.quota.days", count: days, replacing: ["count": String(days)])
}

@MainActor
func localizedQuotaLimitAdjective(
  limitWindowSeconds: Int?,
  using model: MacOSDesignModel
) -> String? {
  guard let seconds = limitWindowSeconds, seconds > 0 else { return nil }
  if seconds == 18000 { return model.localized("desktop.quota.five_hour") }
  if seconds == 604800 { return model.localized("desktop.quota.weekly") }
  if seconds == 86400 { return model.localized("desktop.quota.daily") }
  if seconds == 3600 { return model.localized("desktop.quota.hourly") }
  return localizedQuotaPeriod(limitWindowSeconds: seconds, using: model)
}

@MainActor
func localizedQuotaWindowLabel(_ window: DesignUsageWindow, using model: MacOSDesignModel) -> String {
  let clean = window.label.trimmingCharacters(in: .whitespacesAndNewlines)
  if !["", "primary", "secondary", "5h", "weekly", "daily", "monthly", "session", "quota"].contains(clean.lowercased()) { return clean }
  if clean.localizedCaseInsensitiveContains("limit remaining") {
    return clean.isEmpty ? model.localized("desktop.quota.quota") : clean
  }
  if let seconds = window.limitWindowSeconds, seconds > 0 {
    if seconds == 18000 { return "5h" }
    if seconds == 3600 { return "1h" }
    if seconds == 86400 { return model.localized("desktop.quota.label_daily") }
    if seconds == 604800 { return model.localized("desktop.quota.label_weekly") }
    if seconds >= 2419200 && seconds <= 2678400 { return model.localized("desktop.quota.label_monthly") }
    let hours = seconds / 3600
    if hours > 0 && hours < 24 { return "\(hours)h" }
    let days = seconds / 86400
    if days > 0 && days < 7 { return "\(days)d" }
  }
  if clean.localizedCaseInsensitiveCompare("primary") == .orderedSame { return "5h" }
  if clean.localizedCaseInsensitiveCompare("secondary") == .orderedSame {
    return model.localized("desktop.quota.label_weekly")
  }
  switch clean.lowercased() {
  case "session": return model.localized("desktop.quota.label_session")
  case "weekly": return model.localized("desktop.quota.label_weekly")
  case "monthly": return model.localized("desktop.quota.label_monthly")
  case "daily": return model.localized("desktop.quota.label_daily")
  case "quota": return model.localized("desktop.quota.quota")
  default: break
  }
  return clean.isEmpty ? model.localized("desktop.quota.quota") : clean
}

@MainActor
func localizedQuotaResetFormatted(
  using model: MacOSDesignModel,
  resetsAtMs: Double?,
  limitWindowSeconds: Int? = nil,
  now: Date = Date()
) -> String? {
  guard let ms = resetsAtMs, ms > 0 else {
    guard let period = localizedQuotaPeriod(limitWindowSeconds: limitWindowSeconds, using: model) else {
      return nil
    }
    return model.localized("desktop.quota.every_period", replacing: ["period": period])
  }
  let targetDate = Date(timeIntervalSince1970: ms / 1000)
  let diff = targetDate.timeIntervalSince(now)
  if diff <= 0 { return model.localized("desktop.quota.reset_soon") }
  if diff < 3600 {
    let count = max(1, Int((diff / 60).rounded()))
    return model.localized("desktop.quota.in_minutes_short", count: count, replacing: ["count": String(count)])
  }
  if diff < 86400 {
    let count = max(1, Int((diff / 3600).rounded()))
    return model.localized("desktop.quota.in_hours_short", count: count, replacing: ["count": String(count)])
  }
  let formatter = DateFormatter()
  let localeID = model.selectedLanguage == "auto" ? model.resolvedLanguage : model.selectedLanguage
  formatter.locale = Locale(identifier: localeID)
  let calendar = Calendar(identifier: .gregorian)
  let sameYear = calendar.component(.year, from: targetDate) == calendar.component(.year, from: now)
  formatter.setLocalizedDateFormatFromTemplate(sameYear ? "MMMd" : "yMMMd")
  return formatter.string(from: targetDate)
}

@MainActor
func localizedQuotaFullyRefreshFormatted(
  resetsAtMs: Double?,
  using model: MacOSDesignModel,
  now: Date = Date()
) -> String? {
  guard let ms = resetsAtMs, ms > 0 else { return nil }
  let diff = Date(timeIntervalSince1970: ms / 1000).timeIntervalSince(now)
  if diff <= 0 { return model.localized("desktop.quota.fully_refresh_soon") }
  let totalHours = Int(diff / 3600)
  let days = totalHours / 24
  let hours = totalHours % 24
  let duration: String
  if days > 0 && hours > 0 {
    duration = model.localized("desktop.quota.duration_two", replacing: [
      "first": model.localized("desktop.quota.days", count: days, replacing: ["count": String(days)]),
      "second": model.localized("desktop.quota.hours", count: hours, replacing: ["count": String(hours)]),
    ])
  } else if days > 0 {
    duration = model.localized("desktop.quota.days", count: days, replacing: ["count": String(days)])
  } else if hours > 0 {
    duration = model.localized("desktop.quota.hours", count: hours, replacing: ["count": String(hours)])
  } else {
    let minutes = max(1, Int((diff / 60).rounded()))
    duration = model.localized("desktop.quota.minutes", count: minutes, replacing: ["count": String(minutes)])
  }
  return model.localized("desktop.quota.fully_refresh_in", replacing: ["duration": duration])
}

/// One vendor quota section (Antigravity group) or a flat ungrouped list.
struct DesignUsageGroup: Identifiable, Hashable {
  var id: String { title ?? "_ungrouped" }
  let title: String?
  let windows: [DesignUsageWindow]
}

/// Group usage windows by optional `group`, preserving first-seen order.
func groupUsageWindows(_ windows: [DesignUsageWindow]) -> [DesignUsageGroup] {
  var order: [String] = []
  var buckets: [String: [DesignUsageWindow]] = [:]
  var ungrouped: [DesignUsageWindow] = []
  for window in windows {
    let key = window.group?.trimmingCharacters(in: .whitespacesAndNewlines) ?? ""
    if key.isEmpty {
      ungrouped.append(window)
      continue
    }
    if buckets[key] == nil {
      order.append(key)
      buckets[key] = []
    }
    buckets[key]?.append(window)
  }
  var groups = order.map { DesignUsageGroup(title: $0, windows: buckets[$0] ?? []) }
  if !ungrouped.isEmpty {
    groups.append(DesignUsageGroup(title: nil, windows: ungrouped))
  }
  return groups
}

/// Lines surviving a log Clear. The clear hides by count, which a file
/// rotation or restart invalidates: when the tail is strictly shorter than
/// what was hidden, the old count resets — otherwise new entries stay hidden
/// forever. Equal counts keep hiding (same tail, still cleared); a
/// same-length restart still hides, and only a byte offset would catch that.
func visibleLogLines(_ lines: [String], hiddenCount: inout Int, limit: Int = 160) -> [String] {
  if lines.count < hiddenCount { hiddenCount = 0 }
  return Array(lines.dropFirst(min(hiddenCount, lines.count)).suffix(limit))
}

// MARK: - Backup import

/// Entry IDs to import. Without overwrite the engine skips `replace`
/// dispositions, so an all-skipped selection must warn instead of sitting
/// open with no feedback. Empty means "nothing would change".
func backupImportEntryIDs(
  selectedIDs: Set<String>,
  dispositions: [String: String],
  overwrite: Bool
) -> [String] {
  selectedIDs.filter { id in
    overwrite || dispositions[id] != "replace"
  }.sorted()
}

// MARK: - Overview

/// Saved logins only — API gateways are not logins. A lone gateway used
/// to mark "Save a Login" Done and hide the checklist early.
func overviewHasSavedLogin(accounts: [DesignAccount]) -> Bool {
  accounts.contains { $0.kind == .saved }
}

/// One app counts as pointed when its selected route is a managed,
/// non-native route: a native-only login is setup still to do, and a
/// stale selection missing from the options counts for nothing.
func overviewIsChosenRoute(_ app: DesignApp) -> Bool {
  guard let selected = app.routeOptions.first(where: { $0.id == app.selectedRouteID }) else {
    return false
  }
  return selected.kind != .native
}

/// Checklist predicate shared by fixture and production: both read the
/// snapshot-derived apps, so a native-only login is Not done everywhere.
func overviewHasChosenRoute(apps: [DesignApp]) -> Bool {
  apps.contains(where: overviewIsChosenRoute)
}

/// Primary attention target, ordered from service failures to routing conflicts.
enum OverviewAttentionTarget: Equatable {
  case proxy(id: String)
  case app(id: String)
  case account(id: String)
  case conflict(kind: DesignRoutingConflictKind)
}

func overviewAttentionTarget(
  proxies: [DesignProxy],
  apps: [DesignApp],
  accounts: [DesignAccount],
  conflicts: [DesignRoutingConflict]
) -> OverviewAttentionTarget? {
  if let proxy = proxies.first(where: {
    $0.status == .attention || $0.status == .unavailable
  }) {
    return .proxy(id: proxy.id)
  }
  if let app = apps.first(where: {
    $0.status == .attention || $0.status == .unavailable
  }) {
    return .app(id: app.id)
  }
  if let account = accounts.first(where: {
    $0.status == .attention || $0.status == .unavailable
  }) {
    return .account(id: account.id)
  }
  if conflicts.contains(where: { $0.kind == .sourceChoice }) {
    return .conflict(kind: .sourceChoice)
  }
  if conflicts.contains(where: { $0.kind == .modelOverlap }) {
    return .conflict(kind: .modelOverlap)
  }
  return nil
}

/// Services total: the Hub slot counts only when a hub is configured —
/// sources listed or running — never a phantom +1 ("0 of 1 running").
func overviewServiceTotal(proxyCount: Int, hubSourcesEmpty: Bool, hubEnabled: Bool) -> Int {
  proxyCount + (hubSourcesEmpty && !hubEnabled ? 0 : 1)
}

/// Row summary keeps production detail: the engine's connectionDetail
/// ("Signed in as…", "Configured source unavailable") survives instead of a
/// flat "No login chosen".
func overviewConnectionSummary(_ app: DesignApp) -> String {
  if let name = app.routeOptions.first(where: { $0.id == app.selectedRouteID })?.name {
    return "Uses \(name)"
  }
  return app.detail.isEmpty ? "No login chosen" : app.detail
}

@MainActor
func overviewConnectionSummary(_ app: DesignApp, using model: MacOSDesignModel) -> String {
  if let name = app.routeOptions.first(where: { $0.id == app.selectedRouteID })?.name {
    return model.localized("desktop.overview.uses_account", replacing: ["name": name])
  }
  return app.detail.isEmpty ? model.localized("desktop.overview.no_login_chosen") : app.detail
}

// MARK: - Proxy actions

/// Restart is available for a running service or a stopped service that has a
/// recoverable attention state. Non-running list rows still use Start so the
/// visible action always matches the process lifecycle.
func canRestartProxy(isRunning: Bool, status: DesignStatus) -> Bool {
  isRunning || status == .attention || status == .unavailable
}

// MARK: - Tray state helpers

/// Dismissal primitives for attention notices. Only string IDs cross
/// into the test bundle: the item type lives with the tray chrome, while the
/// key format, legacy compat, and pruning are pinned here. The key is the
/// stable item id — legacy "id|title" keys (any title) still count as
/// dismissed so a copy change cannot resurrect old notices, but new
/// dismissals store the id only.
func trayAttentionDismissed(id: String, title: String, keys: Set<String>) -> Bool {
  keys.contains(id) || keys.contains("\(id)|\(title)")
    || keys.contains(where: { $0.hasPrefix("\(id)|") })
}

/// Insert a dismissal, pruning the persisted set: it never shrinks
/// otherwise and rides every launch via AppPreferences.
func trayDismissAttention(id: String, keys: Set<String>, limit: Int = 100) -> Set<String> {
  var next = keys
  if next.count >= limit, let victim = next.first(where: { $0 != id }) {
    next.remove(victim)
  }
  next.insert(id)
  return next
}

enum TrayInlineSwitchState {
  case available
  case current
  case switching
  case retry
}

/// Inline switch mark matched by route id: duplicate route names across
/// providers used to light the spinner/retry on the wrong row.
func traySwitchStateForRoute(
  phase: DesignSwitchPhase,
  appID: String,
  routeID: String,
  selectedRouteID: String
) -> TrayInlineSwitchState {
  if routeID == selectedRouteID { return .current }
  switch phase {
  case let .inFlight(id, _, _, targetID) where id == appID && routeID == targetID:
    return .switching
  case let .recovery(id, _, _, routeID: wantedID) where id == appID && routeID == wantedID:
    return .retry
  default:
    return .available
  }
}

/// First unused "Work" → "Personal" → "Account N" name. The fixture
/// hardcoded "Work" and duplicated on second save.
func unusedAccountName(existing: [String], candidates: [String] = ["Work", "Personal"]) -> String {
  for candidate in candidates {
    if !existing.contains(where: { $0.caseInsensitiveCompare(candidate) == .orderedSame }) {
      return candidate
    }
  }
  var suffix = existing.count + 1
  while existing.contains(where: {
    $0.caseInsensitiveCompare("Account \(suffix)") == .orderedSame
  }) {
    suffix += 1
  }
  return "Account \(suffix)"
}

// MARK: - ZCode-app plan status (ZAI captive login)

/// Warning from the ZCode desktop app's world-readable plan-status cache.
/// This is only plan-status context; the provider separately reads the
/// encrypted ZCode login and offers the official browser fallback.
func zcodeCodingPlanWarning(_ data: Data) -> String? {
  guard
    let json = try? JSONSerialization.jsonObject(with: data) as? [String: Any],
    let entryStatus = json["entryStatus"] as? [String: Any],
    let items = entryStatus["items"] as? [String: Any],
    !items.isEmpty
  else { return nil }
  let connected = items.values.contains { item in
    guard let entry = item as? [String: Any],
      let status = entry["status"] as? String
    else { return false }
    return status != "unavailable" && !status.isEmpty
  }
  return connected
    ? nil
    : "The ZCode app reports no connected coding plan. You can still use the ZCode login on this Mac, sign in again with Z.ai, or paste a GLM Coding Plan key from the Z.ai dashboard (API Keys)."
}

// MARK: - App state helpers

/// "Add API Gateway…" availability. Any client can use a gateway through
/// the provider picker — the first-party match only preselects a provider in
/// the sheet, so its absence must not disable the action for
/// Kiro/Grok/OpenCode/WorkBuddy.
func canAddGateway(isBusy: Bool, gatewayProviderCount: Int) -> Bool {
  !isBusy && gatewayProviderCount > 0
}

/// True when a client has route actions but none usable and no installed
/// login: the Apps list must show an attention row, not drop the app.
/// Raw action presence (not the enabled-only subset designApp renders) is
/// the signal — all-disabled actions are exactly the vanishing case.
func appNeedsAttentionPlaceholder(
  clientID: String,
  actions: [ActionSnapshot],
  providers: [AccountProviderSnapshot]
) -> Bool {
  if actions.contains(where: { $0.clientId == clientID && $0.enabled }) { return false }
  if providers.contains(where: { $0.clientId == clientID && $0.installed }) { return false }
  return actions.contains(where: { $0.clientId == clientID })
}

/// Engine "direct-account" covers two cases: the client's own native
/// login and a managed route onto another provider's account (e.g. Claude on
/// a Grok account). Only the former is native — the latter must keep the
/// Models section and route management visible.
func appRouteKind(
  routeKind: String?,
  upstreamProviderID: String?,
  clientID: String
) -> DesignRouteKind {
  switch routeKind {
  case "hub": return .hub
  case "gateway": return .gateway
  case "direct-account":
    if let upstream = upstreamProviderID?.trimmingCharacters(in: .whitespacesAndNewlines),
      !upstream.isEmpty,
      nativeProviderFamily(upstream) != nativeProviderFamily(clientID)
    {
      return .account
    }
    return .native
  case "managed-account": return .account
  case "account", "pool": return .account
  default: return .account
  }
}

/// Transport for an app row. Saved-account routes are AnyPick-managed proxy
/// routes; only the client's own native route is a direct connection.
func transportDisplayName(for app: DesignApp) -> String {
  guard let selected = app.routeOptions.first(where: { $0.id == app.selectedRouteID }) else {
    return "Not Configured"
  }
  switch selected.kind {
  case .gateway: return "Gateway"
  case .hub: return "Proxy Hub"
  case .account: return "AnyPick proxy"
  case .native: return "Direct"
  }
}

@MainActor
func transportDisplayName(for app: DesignApp, using model: MacOSDesignModel) -> String {
  guard let selected = app.routeOptions.first(where: { $0.id == app.selectedRouteID }) else {
    return model.localized("desktop.overview.not_configured")
  }
  switch selected.kind {
  case .gateway: return model.localized("desktop.overview.gateway")
  case .hub: return model.localized("desktop.nav.proxy_hub")
  case .account: return model.localized("desktop.apps.anypick_proxy")
  case .native: return model.localized("desktop.overview.direct")
  }
}

func isAppRouteConfigured(_ app: DesignApp) -> Bool {
  !app.selectedRouteID.isEmpty
    && app.routeOptions.contains(where: { $0.id == app.selectedRouteID })
}

func isAppManagedByAnyPick(_ app: DesignApp) -> Bool {
  guard isAppRouteConfigured(app) else { return false }
  guard let route = app.routeOptions.first(where: { $0.id == app.selectedRouteID }) else {
    return false
  }
  return route.kind != .native
}

func appShortDescription(_ clientID: String) -> String {
  switch clientID.lowercased() {
  case "claude": return "Anthropic’s terminal coding agent"
  case "codex": return "OpenAI’s terminal and desktop coding tool"
  case "kiro": return "AI-assisted coding IDE and environment"
  case "commandcode": return "Terminal command AI assistant"
  case "gemini": return "Google’s AI coding tool"
  case "opencode": return "Open-source developer terminal assistant"
  case "workbuddy", "codebuddy": return "Tencent’s AI programming assistant"
  case "zcode": return "Z.ai intelligent development environment"
  case "dsh": return "DeepSeek AI coding harness"
  case "pi": return "Interactive terminal AI agent"
  case "omp": return "Multi-provider AI command line interface"
  default: return "Supported coding application"
  }
}

@MainActor
func appShortDescription(_ clientID: String, using model: MacOSDesignModel) -> String {
  let id = clientID.lowercased() == "codebuddy" ? "codebuddy" : clientID.lowercased()
  return model.localized("desktop.apps.about_\(id)")
}

func usablePublishedModelCount(_ models: [DesignPublishedModel]) -> Int {
  models.filter { !$0.needsChoice }.count
}

func activityAccessibilityLabel(for item: DesignActivity) -> String {
  let parts = [item.day, item.time, item.status.rawValue, item.title, item.detail]
    .map { $0.trimmingCharacters(in: .whitespacesAndNewlines) }
    .filter { !$0.isEmpty }
  return parts.joined(separator: ", ")
}

@MainActor
func activityAccessibilityLabel(
  for item: DesignActivity,
  title: String,
  detail: String,
  model: MacOSDesignModel
) -> String {
  let parts = [item.localizedDay(using: model), item.time, item.status.localizedLabel(using: model), title, detail]
    .map { $0.trimmingCharacters(in: .whitespacesAndNewlines) }
    .filter { !$0.isEmpty }
  return parts.joined(separator: ", ")
}

// MARK: - Add-account state helpers

/// "Test Connection" enablement for AddGatewaySheet. Providers that need no
/// API key stay testable with an empty key field.
func gatewayConnectionTestEnabled(
  requiresApiKey: Bool,
  apiKey: String,
  isBusy: Bool,
  requiresAccountId: Bool = false,
  accountID: String = ""
) -> Bool {
  if isBusy { return false }
  if requiresApiKey && apiKey.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty {
    return false
  }
  if requiresAccountId && accountID.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty {
    return false
  }
  return true
}

/// Submit gate for the saved-account path of AddSavedAccountSheet. A live
/// login without a parsed identity is still saveable.
func addSavedAccountCanSubmit(
  name: String,
  isNewAccountMode: Bool,
  hasIdentity: Bool,
  hasLiveLogin: Bool,
  methodAvailable: Bool,
  providerEnabled: Bool,
  isBlocked: Bool
) -> Bool {
  if isBlocked { return false }
  let named = !name.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty
  if isNewAccountMode, !hasIdentity {
    return named && methodAvailable && providerEnabled
  }
  return named && (hasIdentity || hasLiveLogin) && providerEnabled
}

func addCredentialInputCanSubmit(
  name: String,
  secret: String,
  providerEnabled: Bool,
  isBlocked: Bool,
  secretOptional: Bool = false
) -> Bool {
  if isBlocked { return false }
  let named = !name.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty
  let keyed = secretOptional || !secret.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty
  return named && keyed && providerEnabled
}

/// Inline reason rendered when Sign In / Add is disabled. Nil means no blocker.
func addAccountBlockerMessage(
  provider: DesignProviderOption?,
  method: DesignLoginMethod?,
  isNewAccountMode: Bool
) -> String? {
  guard let provider else {
    return "No compatible providers are installed. Sign in with a supported app, then try again."
  }
  if !provider.enabled {
    return provider.detail.isEmpty
      ? "\(provider.label) is not available on this Mac." : provider.detail
  }
  if isNewAccountMode, let method, !method.available {
    if let reason = method.unavailableReason, !reason.isEmpty { return reason }
    return method.detail.isEmpty ? "\(method.label) is not available." : method.detail
  }
  return nil
}

@MainActor
func addAccountBlockerMessage(
  provider: DesignProviderOption?,
  method: DesignLoginMethod?,
  isNewAccountMode: Bool,
  using model: MacOSDesignModel
) -> String? {
  guard let provider else {
    return model.localized("desktop.add_account.no_compatible_providers")
  }
  if !provider.enabled {
    return provider.detail.isEmpty
      ? model.localized("desktop.add_account.provider_unavailable", replacing: ["provider": provider.label])
      : provider.detail
  }
  if isNewAccountMode, let method, !method.available {
    if let reason = method.unavailableReason, !reason.isEmpty { return reason }
    return method.detail.isEmpty
      ? model.localized("desktop.add_account.method_unavailable", replacing: ["method": method.label])
      : method.detail
  }
  return nil
}

/// Parse "Detected <identity> in <source>" from account-detect results.
/// Matches the last " in " so identities containing that phrase survive.
func accountIdentity(fromDetectionMessage message: String?) -> String? {
  guard let message, message.hasPrefix("Detected ") else { return nil }
  let body = message.dropFirst("Detected ".count)
  guard let range = body.range(of: " in ", options: .backwards) else { return nil }
  let identity = String(body[..<range.lowerBound])
  if identity.isEmpty { return nil }
  if identity == "the current login" { return "Current login" }
  return displaySafeIdentity(identity)
}
