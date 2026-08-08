/**
 * Shell completion scripts for the primary DX surface.
 */

export type Shell = 'zsh' | 'bash' | 'fish';

export function completionScript(shell: Shell): string {
  switch (shell) {
    case 'zsh':
      return zsh();
    case 'bash':
      return bash();
    case 'fish':
      return fish();
    default:
      throw new Error(`Unsupported shell: ${shell}. Use zsh | bash | fish`);
  }
}

const PRIMARY_CMDS =
  'use run current list ls add link unlink reset preset account gateway proxy plugin doctor providers clients update completion';

function zsh(): string {
  return `#compdef anypick
# anypick zsh completion — source <(anypick completion zsh)

_anypick() {
  local -a commands
  commands=(
    'use:Set default client source'
    'run:Launch a client'
    'current:Show effective bindings'
    'list:List accounts, gateways, clients, presets'
    'add:Add an account or gateway'
    'link:Set project binding'
    'unlink:Remove project binding'
    'reset:Remove AnyPick-managed client config'
    'preset:Manage presets'
    'account:Manage accounts'
    'gateway:Manage gateways'
    'proxy:Proxy lifecycle'
    'plugin:Manage plugins'
    'doctor:Health checks'
    'providers:List providers'
    'clients:List clients'
    'update:Update to the latest npm release'
    'completion:Shell completion'
  )

  local context state state_descr line
  typeset -A opt_args

  _arguments -C \\
    '(-h --help)'{-h,--help}'[Help]' \\
    '(-V --version)'{-V,--version}'[Version]' \\
    '--json[JSON output]' \\
    '(-v --verbose)'{-v,--verbose}'[Verbose]' \\
    '--dry-run[Plan only]' \\
    '(-q --quiet)'{-q,--quiet}'[Quiet]' \\
    '1: :->cmds' \\
    '*:: :->args'

  case $state in
    cmds)
      _describe 'command' commands
      ;;
    args)
      case $line[1] in
        use|run|link|unlink|reset)
          if (( CURRENT == 2 )); then
            _values 'client' \${(f)"$(anypick __complete clients 2>/dev/null)"}
          fi
          ;;
        list|ls)
          _values 'kind' accounts gateways clients presets
          ;;
        plugin)
          if (( CURRENT == 2 )); then
            _values 'action' list add remove enable disable trust
          fi
          ;;
        add)
          if (( CURRENT == 2 )); then
            _values 'kind' account gateway
          elif (( CURRENT == 3 )) && [[ $line[2] == account ]]; then
            _values 'provider' \${(f)"$(anypick __complete providers 2>/dev/null)"}
          fi
          ;;
        account)
          if (( CURRENT == 2 )); then
            _values 'action' list remove refresh export import
          elif (( CURRENT == 3 )); then
            _values 'provider' \${(f)"$(anypick __complete providers 2>/dev/null)"}
          elif (( CURRENT == 4 )); then
            _values 'account' \${(f)"$(anypick __complete accounts $line[3] 2>/dev/null)"}
          fi
          ;;
        gateway)
          if (( CURRENT == 2 )); then
            _values 'action' list show edit remove
          elif (( CURRENT >= 3 )); then
            _values 'gateway' \${(f)"$(anypick __complete gateways 2>/dev/null)"}
          fi
          ;;
        proxy)
          if (( CURRENT == 2 )); then
            _values 'action' status start stop enable disable logs config
          elif (( CURRENT == 3 )); then
            _values 'provider' \${(f)"$(anypick __complete providers 2>/dev/null)"}
          elif (( CURRENT == 4 )); then
            _values 'account' \${(f)"$(anypick __complete accounts $line[3] 2>/dev/null)"}
          fi
          ;;
      esac
      ;;
  esac
}

compdef _anypick anypick
`;
}

function bash(): string {
  return `# anypick bash completion — source <(anypick completion bash)

_anypick() {
  local cur prev
  COMPREPLY=()
  cur="\${COMP_WORDS[COMP_CWORD]}"
  prev="\${COMP_WORDS[COMP_CWORD-1]}"
  local cmds="${PRIMARY_CMDS}"

  if [[ \${COMP_CWORD} -eq 1 ]]; then
    COMPREPLY=( $(compgen -W "\${cmds}" -- "\${cur}") )
    return
  fi

  local cmd="\${COMP_WORDS[1]}"
  case "\${cmd}" in
    use|run|link|unlink|reset)
      if [[ \${COMP_CWORD} -eq 2 ]]; then
        COMPREPLY=( $(compgen -W "$(anypick __complete clients 2>/dev/null)" -- "\${cur}") )
      fi
      ;;
    list|ls)
      COMPREPLY=( $(compgen -W "accounts gateways clients presets" -- "\${cur}") )
      ;;
    plugin)
      if [[ \${COMP_CWORD} -eq 2 ]]; then
        COMPREPLY=( $(compgen -W "list add remove enable disable trust" -- "\${cur}") )
      fi
      ;;
    add)
      if [[ \${COMP_CWORD} -eq 2 ]]; then
        COMPREPLY=( $(compgen -W "account gateway" -- "\${cur}") )
      elif [[ \${COMP_CWORD} -eq 3 && \${COMP_WORDS[2]} == account ]]; then
        COMPREPLY=( $(compgen -W "$(anypick __complete providers 2>/dev/null)" -- "\${cur}") )
      fi
      ;;
    account)
      if [[ \${COMP_CWORD} -eq 2 ]]; then
        COMPREPLY=( $(compgen -W "list remove refresh export import" -- "\${cur}") )
      elif [[ \${COMP_CWORD} -eq 3 ]]; then
        COMPREPLY=( $(compgen -W "$(anypick __complete providers 2>/dev/null)" -- "\${cur}") )
      fi
      ;;
    gateway)
      if [[ \${COMP_CWORD} -eq 2 ]]; then
        COMPREPLY=( $(compgen -W "list show edit remove" -- "\${cur}") )
      else
        COMPREPLY=( $(compgen -W "$(anypick __complete gateways 2>/dev/null)" -- "\${cur}") )
      fi
      ;;
    proxy)
      if [[ \${COMP_CWORD} -eq 2 ]]; then
        COMPREPLY=( $(compgen -W "status start stop enable disable logs config" -- "\${cur}") )
      elif [[ \${COMP_CWORD} -eq 3 ]]; then
        COMPREPLY=( $(compgen -W "$(anypick __complete providers 2>/dev/null)" -- "\${cur}") )
      fi
      ;;
  esac
}
complete -F _anypick anypick
`;
}

function fish(): string {
  return `# anypick fish completion — anypick completion fish > ~/.config/fish/completions/anypick.fish

complete -c anypick -f
complete -c anypick -n __fish_use_subcommand -a use -d 'Set default client source'
complete -c anypick -n __fish_use_subcommand -a run -d 'Launch a client'
complete -c anypick -n __fish_use_subcommand -a current -d 'Show bindings'
complete -c anypick -n __fish_use_subcommand -a list -d 'List resources'
complete -c anypick -n __fish_use_subcommand -a add -d 'Add account or gateway'
complete -c anypick -n __fish_use_subcommand -a link -d 'Project binding'
complete -c anypick -n __fish_use_subcommand -a unlink -d 'Remove project binding'
complete -c anypick -n __fish_use_subcommand -a reset -d 'Reset client'
complete -c anypick -n __fish_use_subcommand -a preset -d 'Presets'
complete -c anypick -n __fish_use_subcommand -a account -d 'Accounts'
complete -c anypick -n __fish_use_subcommand -a gateway -d 'Gateways'
complete -c anypick -n __fish_use_subcommand -a proxy -d 'Proxy'
complete -c anypick -n __fish_use_subcommand -a plugin -d 'Plugins'
complete -c anypick -n __fish_use_subcommand -a doctor -d 'Health check'
complete -c anypick -n __fish_use_subcommand -a update -d 'Update to latest release'

complete -c anypick -n '__fish_seen_subcommand_from use run link unlink reset' -a '(anypick __complete clients 2>/dev/null)'
complete -c anypick -n '__fish_seen_subcommand_from list' -a 'accounts gateways clients presets'
complete -c anypick -n '__fish_seen_subcommand_from add' -a 'account gateway'
complete -c anypick -n '__fish_seen_subcommand_from plugin' -a 'list add remove enable disable trust'
`;
}
