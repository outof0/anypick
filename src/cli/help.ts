import pc from 'picocolors';

/**
 * Root help after-text per DX redesign spec §24.1
 */
export function afterHelpText(): string {
  return `
${pc.bold('Common')}
  ${pc.cyan('hotplug use claude --with grok/work')}   set default source
  ${pc.cyan('hotplug use claude --with gemini/work')} Claude via Gemini proxy
  ${pc.cyan('hotplug use claude --current')}          re-apply stored binding
  ${pc.cyan('hotplug run claude')}                    launch with effective binding
  ${pc.cyan('hotplug run claude --with openrouter-work')}
  ${pc.cyan('hotplug current')}                       show bindings
  ${pc.cyan('hotplug list')}                          accounts · gateways · clients · presets
  ${pc.cyan('hotplug add account codex --current --name personal')}
  ${pc.cyan('hotplug add account gemini --current --name work')}
  ${pc.cyan('hotplug add gateway openrouter-work --provider openrouter --endpoint …')}
  ${pc.cyan('hotplug reset claude')}

${pc.bold('Projects')}
  ${pc.cyan('hotplug link claude')}                   project binding from global
  ${pc.cyan('hotplug link claude --with grok/work')}
  ${pc.cyan('hotplug unlink claude')}

${pc.bold('Proxy pool (opt-in multi-account)')}
  ${pc.cyan('hotplug proxy pool enable gemini')}      one endpoint, many logins
  ${pc.cyan('hotplug use claude --with pool:gemini')}

${pc.bold('Troubleshooting')}
  ${pc.cyan('hotplug doctor')}   ${pc.cyan('hotplug completion zsh')}   ${pc.cyan('hotplug update')}

${pc.bold('Manage')}
  ${pc.cyan('account')}  ${pc.cyan('gateway')}  ${pc.cyan('preset')}  ${pc.cyan('proxy')}

${pc.dim('Grammar: use|run <client> --with <source|@preset|pool:provider>')}
${pc.dim('TUI: bare hotplug · g gateways · models on Proxy/Gateways · p multi pool')}
`;
}

export function proxyHelp(): string {
  return `
  hotplug proxy
  hotplug proxy start  [provider [account]] [-p port]
  hotplug proxy stop   [provider [account]]
  hotplug proxy enable  <provider> <account> [-p port] [--oauth-source auto|gemini-cli|antigravity]
  hotplug proxy config  <provider> <account> [-p port] [--oauth-source auto|gemini-cli|antigravity]
  hotplug proxy disable <provider> <account>
  hotplug proxy logs    <provider> [account]

  ${pc.bold('Multi-account pool')} (default is still one proxy per account)
  hotplug proxy pool status  <provider>
  hotplug proxy pool enable  <provider> [-p port]
  hotplug proxy pool disable <provider>
  hotplug proxy pool member  <provider> <account> on|off

  ${pc.bold('Sources')}
  grok/work · opencode/zen · gemini/work · kiro/work · pool:gemini

  ${pc.dim('Gemini supports API keys, Gemini CLI OAuth, and explicit Antigravity OAuth.')}
  ${pc.dim('TUI: enter manage apps · m models · p multi pool')}
`;
}
