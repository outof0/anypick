import Foundation

enum DesignFixture {
  /// Stable future reset for Antigravity fixture rows (days/hours from now).
  static func antigravityResetMs(days: Int, hours: Int) -> Double {
    (Date().timeIntervalSince1970 + Double(days * 86_400 + hours * 3_600)) * 1000
  }

  static func populated() -> (
    apps: [DesignApp],
    accounts: [DesignAccount],
    proxies: [DesignProxy],
    activity: [DesignActivity],
    liveLogLines: [String],
    backups: [DesignBackup]
  ) {
    let sharedRoutes = [
      DesignRoute(
        id: "work", name: "Work", detail: "alex@studio.example", symbol: "briefcase", badge: "72%"
      ),
      DesignRoute(
        id: "personal", name: "Personal", detail: "alex@example.com", symbol: "person",
        badge: "41% left"
      ),
      DesignRoute(
        id: "team", name: "Team", detail: "team@studio.example", symbol: "person.3",
        badge: "Resets in 2h"
      ),
      DesignRoute(
        id: "proxy-hub",
        name: "Proxy Hub",
        detail: "Shared models and accounts",
        symbol: "point.3.connected.trianglepath.dotted",
        kind: .hub,
        providerID: "proxy-hub"
      ),
      DesignRoute(
        id: "openrouter", name: "OpenRouter", detail: "Production", symbol: "network",
        badge: "Production", kind: .gateway, providerID: "openrouter"
      ),
      DesignRoute(
        id: "staging", name: "Staging", detail: "Unavailable", symbol: "network",
        badge: "Unavailable", kind: .gateway
      ),
    ]

    let codexExtraAccounts = [
      DesignRoute(
        id: "openai-lab", name: "OpenAI Lab", detail: "lab@studio.example", symbol: "flask",
        badge: "88% left"
      ),
      DesignRoute(
        id: "oss", name: "OSS", detail: "oss@studio.example", symbol: "chevron.left.forwardslash.chevron.right",
        badge: "Resets 4h"
      ),
      DesignRoute(
        id: "research", name: "Research", detail: "research@studio.example", symbol: "books.vertical",
        badge: "53% left"
      ),
      DesignRoute(
        id: "production", name: "Production", detail: "prod@studio.example", symbol: "shippingbox",
        badge: "Resets 1h"
      ),
      DesignRoute(
        id: "sandbox", name: "Sandbox", detail: "sandbox@studio.example", symbol: "cube.transparent",
        badge: "92% left"
      ),
      DesignRoute(
        id: "client-work", name: "Client Work", detail: "client@studio.example", symbol: "building.2",
        badge: "38% left"
      ),
      DesignRoute(
        id: "backup", name: "Backup", detail: "backup@studio.example", symbol: "archivebox",
        badge: "Ready"
      ),
    ]

    let apps = [
      DesignApp(
        id: "claude",
        name: "Claude Code",
        detail: "Uses Work · alex@studio.example",
        symbol: "brain.head.profile",
        status: .ready,
        accountCount: 3,
        selectedRouteID: "work",
        routeOptions: [
          DesignRoute(
            id: "native-claude",
            name: "Direct account",
            detail: "Login managed by Claude Code",
            symbol: "laptopcomputer",
            kind: .native
          ),
        ] + sharedRoutes,
        fastModel: "claude-haiku-4-5",
        reasoningModel: "claude-opus-4-1",
        useCompatibleFallback: true,
        modelRoles: [
          DesignModelRole(id: "default", label: "Default", modelID: "Claude Opus 4.1"),
          DesignModelRole(id: "sonnet", label: "Sonnet", modelID: ""),
        ],
        modelOptions: ["Claude Opus 4.1", "Claude Sonnet 4", "Claude Haiku 4.5"],
        usageWindows: [
          DesignUsageWindow(label: "5h", remainingPercent: 72, limitWindowSeconds: 18000),
          DesignUsageWindow(label: "Weekly", remainingPercent: 41, limitWindowSeconds: 604800),
          DesignUsageWindow(label: "Fable · Weekly", remainingPercent: 58, limitWindowSeconds: 604800),
        ],
        usageRemaining: "72% remaining"
      ),
      DesignApp(
        id: "codex",
        name: "Codex CLI",
        detail: "Uses Work",
        symbol: "terminal.fill",
        status: .ready,
        showInQuickPanel: false,
        accountCount: 10,
        selectedRouteID: "work",
        routeOptions: [
          DesignRoute(
            id: "native-codex",
            name: "Direct account",
            detail: "Login managed by Codex CLI",
            symbol: "laptopcomputer",
            kind: .native
          ),
        ] + sharedRoutes + codexExtraAccounts,
        fastModel: "gpt-5.1-codex-mini",
        reasoningModel: "GPT-5.6 Codex",
        useCompatibleFallback: true,
        modelRoles: [
          DesignModelRole(id: "default", label: "Default", modelID: "GPT-5.6 Codex"),
        ],
        modelOptions: ["GPT-5.6 Codex", "gpt-5.1-codex-mini"],
        usageWindows: [
          DesignUsageWindow(label: "Weekly", remainingPercent: 64),
        ],
        usageRemaining: "64% remaining"
      ),
      DesignApp(
        id: "gemini",
        name: "Gemini",
        detail: "Uses Google AI Pro · alex@example.com",
        symbol: "sparkle",
        status: .ready,
        accountCount: 2,
        selectedRouteID: "gemini-personal",
        routeOptions: [
          DesignRoute(
            id: "gemini-personal",
            name: "Google AI Pro",
            detail: "alex@example.com",
            symbol: "person.crop.circle",
            kind: .native
          ),
          DesignRoute(
            id: "gemini-work",
            name: "Work",
            detail: "alex@studio.example",
            symbol: "briefcase",
            kind: .native
          ),
        ],
        fastModel: "gemini-2.5-flash",
        reasoningModel: "Direct account",
        useCompatibleFallback: false,
        // Antigravity retrieveUserQuotaSummary shape: groups × weekly/5h.
        usageWindows: [
          DesignUsageWindow(
            label: "Weekly Limit Remaining", remainingPercent: 95,
            resetsAtMs: DesignFixture.antigravityResetMs(days: 3, hours: 19),
            limitWindowSeconds: 604800, group: "Gemini Models"),
          DesignUsageWindow(
            label: "Five Hour Limit Remaining", remainingPercent: 100,
            limitWindowSeconds: 18000, group: "Gemini Models"),
          DesignUsageWindow(
            label: "Weekly Limit Remaining", remainingPercent: 48,
            resetsAtMs: DesignFixture.antigravityResetMs(days: 4, hours: 1),
            limitWindowSeconds: 604800, group: "Claude and GPT models"),
          DesignUsageWindow(
            label: "Five Hour Limit Remaining", remainingPercent: 100,
            limitWindowSeconds: 18000, group: "Claude and GPT models"),
        ],
        usageRemaining: "95% remaining"
      ),
      DesignApp(
        id: "kiro",
        name: "Kiro",
        detail: "Uses Personal Builder · builder@example.com",
        symbol: "shippingbox.fill",
        status: .ready,
        showInQuickPanel: false,
        accountCount: 2,
        selectedRouteID: "kiro-personal",
        routeOptions: [
          DesignRoute(
            id: "kiro-personal",
            name: "Personal Builder",
            detail: "builder@example.com",
            symbol: "person.crop.circle",
            kind: .native
          ),
          DesignRoute(
            id: "kiro-team",
            name: "Team Builder",
            detail: "team-builder@example.com",
            symbol: "person.2",
            kind: .native
          ),
        ],
        fastModel: "auto",
        reasoningModel: "Direct account",
        useCompatibleFallback: true
      ),
      DesignApp(
        id: "grok",
        name: "Grok",
        detail: "Uses Personal",
        symbol: "network",
        status: .ready,
        accountCount: 2,
        selectedRouteID: "grok-personal",
        routeOptions: [
          DesignRoute(
            id: "grok-personal", name: "Personal", detail: "grok@example.com",
            symbol: "person.crop.circle", kind: .native
          ),
          DesignRoute(
            id: "grok-work", name: "Work", detail: "grok@studio.example",
            symbol: "briefcase", kind: .native
          ),
        ],
        fastModel: "auto",
        reasoningModel: "Direct account",
        useCompatibleFallback: false
      ),
      DesignApp(
        id: "opencode",
        name: "OpenCode",
        detail: "Uses Default",
        symbol: "terminal",
        status: .ready,
        accountCount: 3,
        selectedRouteID: "opencode-default",
        routeOptions: [
          DesignRoute(
            id: "opencode-default", name: "Default", detail: "opencode-go",
            symbol: "person.crop.circle", kind: .native
          ),
          DesignRoute(
            id: "openrouter", name: "OpenRouter", detail: "openrouter.ai", symbol: "network",
            badge: "Production", kind: .gateway, providerID: "openrouter"
          ),
          DesignRoute(
            id: "staging", name: "Staging Gateway", detail: "api.staging.example", symbol: "network",
            badge: "Unavailable", kind: .gateway
          ),
        ],
        fastModel: "auto",
        reasoningModel: "Direct account",
        useCompatibleFallback: false
      ),
      DesignApp(
        id: "workbuddy",
        name: "WorkBuddy",
        detail: "Uses WorkBuddy international",
        symbol: "briefcase.fill",
        status: .ready,
        accountCount: 1,
        selectedRouteID: "workbuddy-international",
        routeOptions: [
          DesignRoute(
            id: "workbuddy-international", name: "WorkBuddy international",
            detail: "www.codebuddy.ai", symbol: "person.crop.circle", kind: .native
          ),
          DesignRoute(
            id: "codebuddy-china", name: "CodeBuddy China",
            detail: "copilot.tencent.com", symbol: "person.crop.circle", kind: .native
          ),
        ],
        fastModel: "auto",
        reasoningModel: "Direct account",
        useCompatibleFallback: false
      ),
    ]

    let accounts = [
      DesignAccount(
        id: "claude-work", name: "Work", detail: "alex@studio.example", provider: "Claude",
        symbol: "brain.head.profile", kind: .saved, status: .running, lastUsed: "Used now",
        providerID: "claude"
      ),
      DesignAccount(
        id: "claude-personal", name: "Personal", detail: "alex@example.com",
        provider: "Claude", symbol: "brain.head.profile", kind: .saved, status: .ready,
        lastUsed: "4 minutes ago", providerID: "claude"
      ),
      DesignAccount(
        id: "claude-client", name: "Client", detail: "client@agency.example",
        provider: "Claude", symbol: "brain.head.profile", kind: .saved, status: .attention,
        lastUsed: "3 days ago", providerID: "claude"
      ),
      DesignAccount(
        id: "google-pro", name: "Google AI Pro", detail: "alex@example.com",
        provider: "Gemini", symbol: "sparkle", kind: .saved, status: .ready,
        lastUsed: "12 minutes ago", providerID: "gemini"
      ),
      DesignAccount(
        id: "claude-team", name: "Team", detail: "team@studio.example",
        provider: "Claude", symbol: "brain.head.profile", kind: .saved, status: .ready,
        lastUsed: "This morning", providerID: "claude"
      ),
      DesignAccount(
        id: "codex-work", name: "Work", detail: "maya@studio.example",
        provider: "Codex", symbol: "terminal.fill", kind: .saved, status: .running,
        lastUsed: "8 minutes ago", providerID: "codex"
      ),
      DesignAccount(
        id: "codex-personal", name: "Personal", detail: "alex@example.com",
        provider: "Codex", symbol: "terminal.fill", kind: .saved, status: .ready,
        lastUsed: "Yesterday", providerID: "codex"
      ),
      DesignAccount(
        id: "personal-builder", name: "Personal Builder", detail: "builder@example.com",
        provider: "Kiro", symbol: "shippingbox.fill", kind: .saved, status: .ready,
        lastUsed: "Yesterday", providerID: "kiro"
      ),
      DesignAccount(
        id: "grok-work", name: "Work", detail: "alex@x.example",
        provider: "Grok", symbol: "sparkles", kind: .saved, status: .ready,
        lastUsed: "Today", providerID: "grok"
      ),
      DesignAccount(
        id: "openrouter", name: "OpenRouter", detail: "openrouter.ai",
        provider: "OpenRouter", symbol: "network", kind: .gateway, status: .ready,
        lastUsed: "Used now", providerID: "openrouter"
      ),
      DesignAccount(
        id: "staging", name: "Staging Gateway", detail: "api.staging.example",
        provider: "Custom", symbol: "server.rack", kind: .gateway, status: .attention,
        lastUsed: "3 days ago", providerID: "custom"
      ),
    ]

    let proxies = [
      DesignProxy(
        id: "claude-relay", name: "Claude Relay", detail: "Work · Claude",
        symbol: "brain.head.profile", provider: "claude", status: .running, port: 41_411,
        enabled: true, apiKey: "ap_0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef"
      ),
      DesignProxy(
        id: "codex-relay", name: "Codex Relay", detail: "Personal · Codex",
        symbol: "terminal.fill", provider: "codex", status: .stopped, port: 41_412, enabled: false
      ),
      DesignProxy(
        id: "kiro-bridge", name: "Kiro Bridge", detail: "Personal Builder · Kiro",
        symbol: "shippingbox.fill", provider: "kiro", status: .stopped, port: 41_413,
        enabled: false
      ),
    ]

    let activity = [
      DesignActivity(
        id: "a1", day: "Today", time: "09:42", title: "Claude Code now uses Work",
        detail: "Previous app settings were backed up.",
        symbol: "arrow.triangle.2.circlepath", status: .ready, provider: "Claude",
        titleKey: "desktop.activity.app_uses_source",
        titleArguments: ["client": "Claude Code", "source": "Work"],
        detailKey: "desktop.activity.sample_backup_settings", kind: "activation"
      ),
      DesignActivity(
        id: "a2", day: "Today", time: "09:18", title: "OpenRouter check failed.",
        detail: "Authentication failed. The saved gateway was not changed.",
        symbol: "exclamationmark.circle.fill", status: .attention, provider: "OpenRouter",
        titleKey: "desktop.activity.sample_gateway_check_failed",
        titleArguments: ["gateway": "OpenRouter"],
        detailKey: "desktop.activity.sample_auth_failed", kind: "gateway"
      ),
      DesignActivity(
        id: "a3", day: "Today", time: "08:57", title: "Proxy Hub started",
        detail: "Listening on a local authenticated address.",
        symbol: "antenna.radiowaves.left.and.right", status: .ready,
        titleKey: "desktop.activity.sample_hub_started",
        detailKey: "desktop.activity.sample_local_address", kind: "proxy"
      ),
      DesignActivity(
        id: "a4", day: "Today", time: "08:43", title: "Work saved",
        detail: "Current Claude login stored as a saved account.",
        symbol: "archivebox.fill", status: .ready, provider: "Claude",
        titleKey: "desktop.activity.sample_account_saved",
        titleArguments: ["account": "Work"],
        detailKey: "desktop.activity.sample_login_stored", kind: "account"
      ),
      DesignActivity(
        id: "a5", day: "Yesterday", time: "18:44", title: "Work saved",
        detail: "Claude account backup completed.", symbol: "archivebox.fill", status: .ready,
        provider: "Claude", titleKey: "desktop.activity.sample_account_saved",
        titleArguments: ["account": "Work"],
        detailKey: "desktop.activity.sample_backup_completed",
        detailArguments: ["provider": "Claude"], kind: "account"
      ),
    ]

    let saved = accounts.filter { $0.kind == .saved }
    let backups = [
      DesignBackup(
        id: "backup-1", createdAt: "Today at 09:15", accountCount: saved.count,
        size: "42 KB", location: "AnyPick Backups", accounts: saved
      ),
      DesignBackup(
        id: "backup-2", createdAt: "Yesterday at 18:44", accountCount: 3,
        size: "39 KB", location: "AnyPick Backups", accounts: Array(saved.prefix(3))
      ),
      DesignBackup(
        id: "backup-3", createdAt: "August 9 at 11:08", accountCount: 2,
        size: "31 KB", location: "AnyPick Backups", accounts: Array(saved.prefix(2))
      ),
      DesignBackup(
        id: "backup-import",
        createdAt: "10 Aug 2026 at 09:42",
        accountCount: 4,
        size: "48 KB",
        location: "AnyPick Accounts.anypick-backup",
        accounts: [
          DesignAccount(
            id: "imp-team", name: "Team", detail: "team@studio.example",
            provider: "Claude", symbol: "brain.head.profile", kind: .saved,
            status: .ready, lastUsed: ""
          ),
          DesignAccount(
            id: "imp-work", name: "Work", detail: "alex@studio.example",
            provider: "Claude", symbol: "brain.head.profile", kind: .saved,
            status: .ready, lastUsed: ""
          ),
          DesignAccount(
            id: "imp-personal", name: "Personal",
            detail: "Different identity uses this name",
            provider: "Claude", symbol: "brain.head.profile", kind: .saved,
            status: .ready, lastUsed: ""
          ),
          DesignAccount(
            id: "imp-legacy", name: "Legacy", detail: "Provider plug-in is unavailable",
            provider: "Claude", symbol: "brain.head.profile", kind: .saved,
            status: .unavailable, lastUsed: ""
          ),
        ]
      ),
    ]

    // Console copy for Activity · Live Logs:
    // `HH:MM:SS  <message>`, timestamp first, human message after.
    let liveLogLines = [
      "09:42:11  Proxy Hub listening on 127.0.0.1:41401",
      "09:42:12  Loaded 28 published model IDs",
      "09:42:14  claude-sonnet-4-5 → Work",
      "09:42:17  POST /v1/chat/completions → 200 in 842 ms",
      "09:42:24  gpt-5.6-codex → Personal",
      "09:42:25  POST /v1/responses → 200 in 611 ms",
      "09:42:31  workbuddy/work listening on 127.0.0.1:41411",
      "09:42:38  Credentials redacted from diagnostic output",
      "09:42:41  codex/work listening on 127.0.0.1:41412",
      "09:42:44  POST /v1/messages → 200 in 388 ms",
      "09:42:50  kiro bridge unavailable — waiting for login",
      "09:42:55  GET /health → 200 in 1 ms",
    ]

    return (apps, accounts, proxies, activity, liveLogLines, backups)
  }
}
