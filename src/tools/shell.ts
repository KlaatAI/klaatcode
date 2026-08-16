/**
 * Platform shell for one-liner commands.
 *
 * Every shell-out in the CLI goes through this: `sh` does not exist on a
 * stock Windows box, so spawning it fails with ENOENT (seen live —
 * `uv_spawn 'sh'` killed every run_command in a REPL session). cmd.exe is
 * always present; `/d /s /c` mirrors what Node's own shell:true uses and
 * what the VS Code client's PersistentShell does.
 *
 * The command STRING is platform-native — the model is told the platform in
 * the environment block and writes commands for it, same contract as npm
 * scripts and diagnostics config overrides.
 */
export function shellCommand(command: string): { exe: string; args: string[] } {
  return process.platform === "win32"
    ? { exe: "cmd.exe", args: ["/d", "/s", "/c", command] }
    : { exe: "sh", args: ["-c", command] };
}
