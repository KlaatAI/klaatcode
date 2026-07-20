/**
 * `klaatai completions <shell>` — print static completion scripts.
 *
 * Embedded (not read from disk) so the compiled binary still works.
 * Covers both `klaatai` and `klaatcode` binary names.
 */

export type CompletionShell = "bash" | "zsh" | "fish";

export const COMPLETION_SHELLS: CompletionShell[] = ["bash", "zsh", "fish"];

export function isCompletionShell(s: string): s is CompletionShell {
  return (COMPLETION_SHELLS as string[]).includes(s);
}

const BASH = `# klaatai / klaatcode bash completion
# Install: klaatai completions bash >> ~/.bashrc   # or ~/.bash_completion

_klaatai_completion() {
  local cur prev words cword
  if type _init_completion &>/dev/null; then
    _init_completion -n : || return
  else
    cur="\${COMP_WORDS[COMP_CWORD]}"
    prev="\${COMP_WORDS[COMP_CWORD-1]}"
  fi

  local cmds="chat run login logout whoami upgrade serve web acp completions"
  local global_opts="-v --version -h --help"

  # First argument: top-level command
  if [[ \${COMP_CWORD} -eq 1 ]]; then
    COMPREPLY=( \$(compgen -W "\${cmds} \${global_opts}" -- "\${cur}") )
    return
  fi

  local cmd="\${COMP_WORDS[1]}"
  case "\${cmd}" in
    chat)
      COMPREPLY=( \$(compgen -W "--base-url -r --resume --continue -h --help" -- "\${cur}") )
      ;;
    run)
      COMPREPLY=( \$(compgen -W "--base-url --model --system --max-cost -h --help" -- "\${cur}") )
      ;;
    login)
      COMPREPLY=( \$(compgen -W "--base-url -h --help" -- "\${cur}") )
      ;;
    logout|acp)
      COMPREPLY=( \$(compgen -W "-h --help" -- "\${cur}") )
      ;;
    whoami)
      COMPREPLY=( \$(compgen -W "--base-url --json -h --help" -- "\${cur}") )
      ;;
    upgrade)
      COMPREPLY=( \$(compgen -W "--check -h --help" -- "\${cur}") )
      ;;
    serve)
      COMPREPLY=( \$(compgen -W "--port --api-key --base-url -h --help" -- "\${cur}") )
      ;;
    web)
      COMPREPLY=( \$(compgen -W "--port --api-key --base-url --no-browser -h --help" -- "\${cur}") )
      ;;
    completions)
      COMPREPLY=( \$(compgen -W "bash zsh fish -h --help" -- "\${cur}") )
      ;;
    *)
      COMPREPLY=()
      ;;
  esac
}

complete -F _klaatai_completion klaatai
complete -F _klaatai_completion klaatcode
`;

const ZSH = `#compdef klaatai klaatcode
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

  local curcontext="\$curcontext" state line
  typeset -A opt_args

  _arguments -C \\
    '(-v --version)'{-v,--version}'[Print version and exit]' \\
    '(-h --help)'{-h,--help}'[Show help]' \\
    '1: :->cmds' \\
    '*:: :->args'

  case \$state in
    cmds)
      _describe -t commands 'command' commands
      ;;
    args)
      case \$words[1] in
        chat)
          _arguments \\
            '--base-url[API base URL override]:url:' \\
            '(-r --resume)'{-r,--resume}'[Resume a previous session]:id:' \\
            '--continue[Resume last session]' \\
            '(-h --help)'{-h,--help}'[Show help]' \\
            '1:directory:_files -/'
          ;;
        run)
          _arguments \\
            '--base-url[API base URL override]:url:' \\
            '--model[Force routing tier]:tier:(nano fast code reason heavy)' \\
            '--system[Prepend a system message]:text:' \\
            '--max-cost[Abort at this USD cost]:usd:' \\
            '(-h --help)'{-h,--help}'[Show help]' \\
            '1:prompt:'
          ;;
        login)
          _arguments \\
            '--base-url[API base URL override]:url:' \\
            '(-h --help)'{-h,--help}'[Show help]'
          ;;
        logout|acp)
          _arguments '(-h --help)'{-h,--help}'[Show help]'
          ;;
        whoami)
          _arguments \\
            '--base-url[API base URL override]:url:' \\
            '--json[Output machine-readable JSON]' \\
            '(-h --help)'{-h,--help}'[Show help]'
          ;;
        upgrade)
          _arguments \\
            '--check[Only check for an update]' \\
            '(-h --help)'{-h,--help}'[Show help]'
          ;;
        serve)
          _arguments \\
            '--port[Port to listen on]:port:' \\
            '--api-key[API key override]:key:' \\
            '--base-url[API base URL override]:url:' \\
            '(-h --help)'{-h,--help}'[Show help]'
          ;;
        web)
          _arguments \\
            '--port[Port to listen on]:port:' \\
            '--api-key[API key override]:key:' \\
            '--base-url[API base URL override]:url:' \\
            '--no-browser[Do not open the browser]' \\
            '(-h --help)'{-h,--help}'[Show help]'
          ;;
        completions)
          _arguments \\
            '1:shell:(bash zsh fish)' \\
            '(-h --help)'{-h,--help}'[Show help]'
          ;;
      esac
      ;;
  esac
}

compdef _klaatai klaatai klaatcode
`;

const FISH = `# klaatai / klaatcode fish completion
# Install: klaatai completions fish > ~/.config/fish/completions/klaatai.fish
#          klaatai completions fish > ~/.config/fish/completions/klaatcode.fish

function __klaatai_no_subcommand
  set -l cmd (commandline -opc)
  test (count \$cmd) -eq 1
end

complete -c klaatai -f
complete -c klaatcode -f

for bin in klaatai klaatcode
  complete -c \$bin -n __klaatai_no_subcommand -a chat -d 'Start interactive AI chat (default)'
  complete -c \$bin -n __klaatai_no_subcommand -a run -d 'Run a single prompt non-interactively'
  complete -c \$bin -n __klaatai_no_subcommand -a login -d 'Sign in via browser'
  complete -c \$bin -n __klaatai_no_subcommand -a logout -d 'Clear stored credentials'
  complete -c \$bin -n __klaatai_no_subcommand -a whoami -d 'Show current user info and backend status'
  complete -c \$bin -n __klaatai_no_subcommand -a upgrade -d 'Update klaatcode to the latest version'
  complete -c \$bin -n __klaatai_no_subcommand -a serve -d 'Start a local HTTP REST/SSE API server'
  complete -c \$bin -n __klaatai_no_subcommand -a web -d 'Start a local web UI in the browser'
  complete -c \$bin -n __klaatai_no_subcommand -a acp -d 'Run as an ACP server over stdio'
  complete -c \$bin -n __klaatai_no_subcommand -a completions -d 'Print shell completion script'
  complete -c \$bin -n __klaatai_no_subcommand -s v -l version -d 'Print version and exit'
  complete -c \$bin -n __klaatai_no_subcommand -s h -l help -d 'Show help'

  complete -c \$bin -n '__fish_seen_subcommand_from chat' -l base-url -d 'API base URL override'
  complete -c \$bin -n '__fish_seen_subcommand_from chat' -s r -l resume -d 'Resume a previous session'
  complete -c \$bin -n '__fish_seen_subcommand_from chat' -l continue -d 'Resume last session'

  complete -c \$bin -n '__fish_seen_subcommand_from run' -l base-url -d 'API base URL override'
  complete -c \$bin -n '__fish_seen_subcommand_from run' -l model -d 'Force routing tier'
  complete -c \$bin -n '__fish_seen_subcommand_from run' -l system -d 'Prepend a system message'
  complete -c \$bin -n '__fish_seen_subcommand_from run' -l max-cost -d 'Abort at this USD cost'

  complete -c \$bin -n '__fish_seen_subcommand_from login' -l base-url -d 'API base URL override'
  complete -c \$bin -n '__fish_seen_subcommand_from whoami' -l base-url -d 'API base URL override'
  complete -c \$bin -n '__fish_seen_subcommand_from whoami' -l json -d 'Output machine-readable JSON'
  complete -c \$bin -n '__fish_seen_subcommand_from upgrade' -l check -d 'Only check for an update'

  complete -c \$bin -n '__fish_seen_subcommand_from serve web' -l port -d 'Port to listen on'
  complete -c \$bin -n '__fish_seen_subcommand_from serve web' -l api-key -d 'API key override'
  complete -c \$bin -n '__fish_seen_subcommand_from serve web' -l base-url -d 'API base URL override'
  complete -c \$bin -n '__fish_seen_subcommand_from web' -l no-browser -d 'Do not open the browser'

  complete -c \$bin -n '__fish_seen_subcommand_from completions' -a 'bash zsh fish'
end
`;

const SCRIPTS: Record<CompletionShell, string> = {
  bash: BASH,
  zsh: ZSH,
  fish: FISH,
};

/** Return the completion script for a shell (always ends with a trailing newline). */
export function getCompletionScript(shell: CompletionShell): string {
  const body = SCRIPTS[shell].replace(/^\n/, "");
  return body.endsWith("\n") ? body : body + "\n";
}

export type CompletionsResult =
  | { ok: true; script: string }
  | { ok: false; error: string };

/** Pure resolve — easy to unit-test without calling process.exit. */
export function resolveCompletions(shellArg: string): CompletionsResult {
  const shell = shellArg.toLowerCase();
  if (!isCompletionShell(shell)) {
    return {
      ok: false,
      error: `Unknown shell: ${shellArg}\nUsage: klaatai completions <bash|zsh|fish>\n`,
    };
  }
  return { ok: true, script: getCompletionScript(shell) };
}

export function runCompletions(shellArg: string): void {
  const result = resolveCompletions(shellArg);
  if (!result.ok) {
    process.stderr.write(result.error);
    process.exit(1);
  }
  process.stdout.write(result.script);
}
