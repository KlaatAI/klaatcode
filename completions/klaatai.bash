# klaatai / klaatcode bash completion
# Install: klaatai completions bash >> ~/.bashrc   # or ~/.bash_completion

_klaatai_completion() {
  local cur prev words cword
  if type _init_completion &>/dev/null; then
    _init_completion -n : || return
  else
    cur="${COMP_WORDS[COMP_CWORD]}"
    prev="${COMP_WORDS[COMP_CWORD-1]}"
  fi

  local cmds="chat run login logout whoami upgrade serve web acp completions"
  local global_opts="-v --version -h --help"

  # First argument: top-level command
  if [[ ${COMP_CWORD} -eq 1 ]]; then
    COMPREPLY=( $(compgen -W "${cmds} ${global_opts}" -- "${cur}") )
    return
  fi

  local cmd="${COMP_WORDS[1]}"
  case "${cmd}" in
    chat)
      COMPREPLY=( $(compgen -W "--base-url -r --resume --continue -h --help" -- "${cur}") )
      ;;
    run)
      COMPREPLY=( $(compgen -W "--base-url --model --system --max-cost -h --help" -- "${cur}") )
      ;;
    login)
      COMPREPLY=( $(compgen -W "--base-url -h --help" -- "${cur}") )
      ;;
    logout|acp)
      COMPREPLY=( $(compgen -W "-h --help" -- "${cur}") )
      ;;
    whoami)
      COMPREPLY=( $(compgen -W "--base-url --json -h --help" -- "${cur}") )
      ;;
    upgrade)
      COMPREPLY=( $(compgen -W "--check -h --help" -- "${cur}") )
      ;;
    serve)
      COMPREPLY=( $(compgen -W "--port --api-key --base-url -h --help" -- "${cur}") )
      ;;
    web)
      COMPREPLY=( $(compgen -W "--port --api-key --base-url --no-browser -h --help" -- "${cur}") )
      ;;
    completions)
      COMPREPLY=( $(compgen -W "bash zsh fish -h --help" -- "${cur}") )
      ;;
    *)
      COMPREPLY=()
      ;;
  esac
}

complete -F _klaatai_completion klaatai
complete -F _klaatai_completion klaatcode
