import pc from 'picocolors';

/**
 * Root help after-text per DX redesign spec §24.1
 */
export function afterHelpText(): string {
  return `
${pc.bold('Common')}
  ${pc.cyan('anypick use claude --with grok/work')}   set default source
  ${pc.cyan('anypick use claude --with gemini/work')} Claude via Gemini proxy
  ${pc.cyan('anypick use claude --current')}          re-apply stored binding
  ${pc.cyan('anypick run claude')}                    launch with effective binding
  ${pc.cyan('anypick run claude --with openrouter-work')}
  ${pc.cyan('anypick current')}                       show bindings
  ${pc.cyan('anypick list')}                          accounts · gateways · clients · presets
  ${pc.cyan('anypick add account codex --current --name personal')}
  ${pc.cyan('anypick add account gemini --current --name work')}
  ${pc.cyan('anypick add gateway openrouter-work --provider openrouter --endpoint …')}
  ${pc.cyan('anypick reset claude')}

${pc.bold('Projects')}
  ${pc.cyan('anypick link claude')}                   project binding from global
  ${pc.cyan('anypick link claude --with grok/work')}
  ${pc.cyan('anypick unlink claude')}

${pc.bold('Proxy pool (opt-in multi-account)')}
  ${pc.cyan('anypick proxy pool enable gemini')}      one endpoint, many logins
  ${pc.cyan('anypick use claude --with pool:gemini')}

${pc.bold('Troubleshooting')}
  ${pc.cyan('anypick doctor')}   ${pc.cyan('anypick completion zsh')}   ${pc.cyan('anypick update')}

${pc.bold('Manage')}
  ${pc.cyan('account')}  ${pc.cyan('gateway')}  ${pc.cyan('preset')}  ${pc.cyan('proxy')}

${pc.dim('Grammar: use|run <client> --with <source|@preset|pool:provider>')}
${pc.dim('TUI: bare anypick · g gateways · models on Proxy/Gateways · p multi pool')}
`;
}

export function proxyHelp(): string {
  return `
  anypick proxy
  anypick proxy start  [provider [account]] [-p port]
  anypick proxy stop   [provider [account]]
  anypick proxy enable  <provider> <account> [-p port] [--oauth-source auto|gemini-cli|antigravity]
  anypick proxy config  <provider> <account> [-p port] [--oauth-source auto|gemini-cli|antigravity]
  anypick proxy disable <provider> <account>
  anypick proxy logs    <provider> [account]

  ${pc.bold('Multi-account pool')} (default is still one proxy per account)
  anypick proxy pool status  <provider>
  anypick proxy pool enable  <provider> [-p port]
  anypick proxy pool disable <provider>
  anypick proxy pool member  <provider> <account> on|off

  ${pc.bold('Sources')}
  grok/work · opencode/zen · gemini/work · kiro/work · pool:gemini

  ${pc.dim('Gemini supports API keys, Gemini CLI OAuth, and explicit Antigravity OAuth.')}
  ${pc.dim('TUI: enter manage apps · m models · p multi pool')}
`;
}
