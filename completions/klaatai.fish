# klaatai / klaatcode fish completion
# Install: klaatai completions fish > ~/.config/fish/completions/klaatai.fish
#          klaatai completions fish > ~/.config/fish/completions/klaatcode.fish

function __klaatai_no_subcommand
  set -l cmd (commandline -opc)
  test (count $cmd) -eq 1
end

complete -c klaatai -f
complete -c klaatcode -f

for bin in klaatai klaatcode
  complete -c $bin -n __klaatai_no_subcommand -a chat -d 'Start interactive AI chat (default)'
  complete -c $bin -n __klaatai_no_subcommand -a run -d 'Run a single prompt non-interactively'
  complete -c $bin -n __klaatai_no_subcommand -a login -d 'Sign in via browser'
  complete -c $bin -n __klaatai_no_subcommand -a logout -d 'Clear stored credentials'
  complete -c $bin -n __klaatai_no_subcommand -a whoami -d 'Show current user info and backend status'
  complete -c $bin -n __klaatai_no_subcommand -a upgrade -d 'Update klaatcode to the latest version'
  complete -c $bin -n __klaatai_no_subcommand -a serve -d 'Start a local HTTP REST/SSE API server'
  complete -c $bin -n __klaatai_no_subcommand -a web -d 'Start a local web UI in the browser'
  complete -c $bin -n __klaatai_no_subcommand -a acp -d 'Run as an ACP server over stdio'
  complete -c $bin -n __klaatai_no_subcommand -a completions -d 'Print shell completion script'
  complete -c $bin -n __klaatai_no_subcommand -s v -l version -d 'Print version and exit'
  complete -c $bin -n __klaatai_no_subcommand -s h -l help -d 'Show help'

  complete -c $bin -n '__fish_seen_subcommand_from chat' -l base-url -d 'API base URL override'
  complete -c $bin -n '__fish_seen_subcommand_from chat' -s r -l resume -d 'Resume a previous session'
  complete -c $bin -n '__fish_seen_subcommand_from chat' -l continue -d 'Resume last session'

  complete -c $bin -n '__fish_seen_subcommand_from run' -l base-url -d 'API base URL override'
  complete -c $bin -n '__fish_seen_subcommand_from run' -l model -d 'Force routing tier'
  complete -c $bin -n '__fish_seen_subcommand_from run' -l system -d 'Prepend a system message'
  complete -c $bin -n '__fish_seen_subcommand_from run' -l max-cost -d 'Abort at this USD cost'

  complete -c $bin -n '__fish_seen_subcommand_from login' -l base-url -d 'API base URL override'
  complete -c $bin -n '__fish_seen_subcommand_from whoami' -l base-url -d 'API base URL override'
  complete -c $bin -n '__fish_seen_subcommand_from whoami' -l json -d 'Output machine-readable JSON'
  complete -c $bin -n '__fish_seen_subcommand_from upgrade' -l check -d 'Only check for an update'

  complete -c $bin -n '__fish_seen_subcommand_from serve web' -l port -d 'Port to listen on'
  complete -c $bin -n '__fish_seen_subcommand_from serve web' -l api-key -d 'API key override'
  complete -c $bin -n '__fish_seen_subcommand_from serve web' -l base-url -d 'API base URL override'
  complete -c $bin -n '__fish_seen_subcommand_from web' -l no-browser -d 'Do not open the browser'

  complete -c $bin -n '__fish_seen_subcommand_from completions' -a 'bash zsh fish'
end
