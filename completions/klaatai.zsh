#compdef klaatai klaatcode
# klaatai / klaatcode zsh completion
# Install: klaatai completions zsh > ~/.zfunc/_klaatai
#          fpath+=(~/.zfunc); autoload -Uz compinit; compinit

_klaatai() {
  local -a commands
  commands=(
    'chat:Start interactive AI chat (default)'
    'run:Run a single prompt non-interactively'
    'login:Sign in via browser'
    'logout:Clear stored credentials'
    'whoami:Show current user info and backend status'
    'upgrade:Update klaatcode to the latest version'
    'serve:Start a local HTTP REST/SSE API server'
    'web:Start a local web UI in the browser'
    'acp:Run as an ACP server over stdio'
    'completions:Print shell completion script'
  )

  local curcontext="$curcontext" state line
  typeset -A opt_args

  _arguments -C \
    '(-v --version)'{-v,--version}'[Print version and exit]' \
    '(-h --help)'{-h,--help}'[Show help]' \
    '1: :->cmds' \
    '*:: :->args'

  case $state in
    cmds)
      _describe -t commands 'command' commands
      ;;
    args)
      case $words[1] in
        chat)
          _arguments \
            '--base-url[API base URL override]:url:' \
            '(-r --resume)'{-r,--resume}'[Resume a previous session]:id:' \
            '--continue[Resume last session]' \
            '(-h --help)'{-h,--help}'[Show help]' \
            '1:directory:_files -/'
          ;;
        run)
          _arguments \
            '--base-url[API base URL override]:url:' \
            '--model[Force routing tier]:tier:(nano fast code reason heavy)' \
            '--system[Prepend a system message]:text:' \
            '--max-cost[Abort at this USD cost]:usd:' \
            '(-h --help)'{-h,--help}'[Show help]' \
            '1:prompt:'
          ;;
        login)
          _arguments \
            '--base-url[API base URL override]:url:' \
            '(-h --help)'{-h,--help}'[Show help]'
          ;;
        logout|acp)
          _arguments '(-h --help)'{-h,--help}'[Show help]'
          ;;
        whoami)
          _arguments \
            '--base-url[API base URL override]:url:' \
            '--json[Output machine-readable JSON]' \
            '(-h --help)'{-h,--help}'[Show help]'
          ;;
        upgrade)
          _arguments \
            '--check[Only check for an update]' \
            '(-h --help)'{-h,--help}'[Show help]'
          ;;
        serve)
          _arguments \
            '--port[Port to listen on]:port:' \
            '--api-key[API key override]:key:' \
            '--base-url[API base URL override]:url:' \
            '(-h --help)'{-h,--help}'[Show help]'
          ;;
        web)
          _arguments \
            '--port[Port to listen on]:port:' \
            '--api-key[API key override]:key:' \
            '--base-url[API base URL override]:url:' \
            '--no-browser[Do not open the browser]' \
            '(-h --help)'{-h,--help}'[Show help]'
          ;;
        completions)
          _arguments \
            '1:shell:(bash zsh fish)' \
            '(-h --help)'{-h,--help}'[Show help]'
          ;;
      esac
      ;;
  esac
}

compdef _klaatai klaatai klaatcode
