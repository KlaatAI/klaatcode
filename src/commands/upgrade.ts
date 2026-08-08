/**
 * `klaatcode upgrade` — self-update through whichever channel installed us.
 *
 * Channel detection is path-based on the resolved binary location:
 *   node_modules/ | .bun/install/  → npm  (npm i -g klaatcode@latest)
 *   Cellar/ | linuxbrew/            → brew (brew upgrade klaatcode)
 *   ~/.klaatcode/                   → curl / PowerShell installer (re-run it)
 *   running via bun src/            → source checkout (git pull)
 *
 * An upgrade is only believed once the installed binary REPORTS the new
 * version: a zero exit code proves nothing when a stale copy still shadows
 * PATH (the retired `klaatcode-ai` 1.x package is the classic case — the new
 * package installs fine and the old bin keeps winning). On a failed command or
 * a failed verification we escalate to a repair: uninstall, clear the cache,
 * install clean. See performUpgrade().
 *
 * Windows notes:
 *   - npm must run through cmd.exe (npm is a .cmd shim — bare spawnSync fails).
 *   - The PowerShell installer cannot overwrite klaatcode.exe while it is
 *     running, so we spawn a detached helper that waits for this PID to exit
 *     and then re-runs the install script.
 */

import { spawn, spawnSync, type SpawnSyncReturns } from "node:child_process";
import { realpathSync, rmSync } from "node:fs";
import { homedir } from "node:os";
import { basename, join } from "node:path";
import { checkForUpdate, clearDismissal, compareSemver, parseVersionOutput } from "../utils/update.js";
import { version as VERSION } from "../../package.json";

export type InstallChannel =
  | "npm"
  | "brew"
  | "installer"          // curl -fsSL klaatai.com/api/install | bash
  | "installer-windows"  // irm klaatai.com/api/install-windows | iex
  | "source"
  | "unknown";

const INSTALLER_WIN_URL = "https://klaatai.com/api/install-windows";

/** The shipped binary name — what every install channel puts on PATH. */
export const BIN_NAME = "klaatcode";

/** Why an upgrade attempt did not end with the new version installed. */
export type UpgradeFailure =
  | "permission"   // EACCES/EPERM on a global prefix — sudo or another channel
  | "network"      // registry/download unreachable
  | "not-found"    // the package manager itself is missing from PATH
  | "verify"       // command succeeded but the binary still reports the old version
  | "unknown";

export interface UpgradeOutcome {
  ok: boolean;
  channel: InstallChannel;
  from: string;
  /** Target version, when a check succeeded. */
  to?: string;
  /** Version the binary reported after the attempt, if we could read it. */
  installed?: string;
  /** true ⇒ the upgrade will complete after this process exits (Windows helper). */
  scheduled?: boolean;
  /** true ⇒ plain upgrade failed and the uninstall+reinstall repair was run. */
  repaired?: boolean;
  failure?: UpgradeFailure;
  /** Human-facing explanation; already includes the manual fallback command. */
  message?: string;
  /** Extra copies of the binary on PATH — the usual cause of a failed verify. */
  shadowed?: string[];
}

/** Normalize paths so detection works on Windows backslashes. */
export function normalizeExePath(p: string): string {
  return p.replace(/\\/g, "/");
}

/**
 * Detect install channel from a resolved executable path.
 * Exported for unit tests — pass `platform`/`scriptPath` to simulate OS layouts.
 */
export function detectInstallChannelFromPath(
  exePath: string,
  platform: NodeJS.Platform = process.platform,
  scriptPath = "",
  homeDir = homedir(),
): InstallChannel {
  const exe = basename(exePath);
  const script = normalizeExePath(scriptPath);

  // Dev: `bun run src/main.tsx` — execPath is the bun runtime itself.
  if (exe === "bun" || exe === "bun.exe" || /\.(ts|tsx|js)$/.test(script)) return "source";

  // npm launcher on Windows can run as `node …/klaatcode/bin/klaatcode` without
  // spawning the compiled binary (e.g. an interrupted/global link setup).
  if ((exe === "node" || exe === "node.exe") &&
      (script.includes("/node_modules/klaatcode/") || script.includes("/.bun/install/"))) {
    return "npm";
  }

  const p = normalizeExePath(exePath);
  if (p.includes("/node_modules/") || p.includes("/.bun/install/")) return "npm";
  if (p.includes("/Cellar/") || p.includes("/linuxbrew/")) return "brew";

  const installerDir = normalizeExePath(join(homeDir, ".klaatcode"));
  if (p.startsWith(installerDir)) {
    return platform === "win32" ? "installer-windows" : "installer";
  }
  return "unknown";
}

export function detectInstallChannel(): InstallChannel {
  let exe = process.execPath;
  try { exe = realpathSync(exe); } catch { /* keep unresolved */ }
  return detectInstallChannelFromPath(exe, process.platform, process.argv[1] ?? "");
}

const CHANNEL_COMMANDS: Record<Exclude<InstallChannel, "source" | "unknown" | "installer-windows">, { label: string; cmd: string[] }> = {
  npm:  { label: "npm",       cmd: ["npm", "install", "-g", "klaatcode@latest"] },
  brew: { label: "Homebrew",  cmd: ["brew", "upgrade", "KlaatAI/klaatcode/klaatcode"] },
  installer: {
    label: "install script",
    cmd: ["bash", "-c", "curl -fsSL https://klaatai.com/api/install | bash"],
  },
};

/** Manual commands printed when everything automatic has failed. */
export const MANUAL_COMMANDS = [
  "npm i -g klaatcode@latest",
  "brew upgrade KlaatAI/klaatcode/klaatcode",
  "curl -fsSL https://klaatai.com/api/install | bash",
  "irm https://klaatai.com/api/install-windows | iex",
];

const BOLD = "\x1b[1m", DIM = "\x1b[2m", CYAN = "\x1b[36m", GREEN = "\x1b[32m", YELLOW = "\x1b[33m", RED = "\x1b[31m", RESET = "\x1b[0m";

/** Absolute path to Windows PowerShell — avoids PATH issues on Server Core etc. */
export function windowsPowerShellExe(): string {
  const root = process.env.SystemRoot ?? process.env.WINDIR ?? "C:\\Windows";
  return join(root, "System32", "WindowsPowerShell", "v1.0", "powershell.exe");
}

/**
 * Resolve the real argv for an upgrade command. Windows npm/brew-style shims
 * are .cmd files, which CreateProcess cannot exec directly — they must go
 * through cmd.exe. Pure, so both runners share one code path.
 */
export function upgradeCommandArgv(cmd: string[], platform: NodeJS.Platform = process.platform): string[] {
  if (platform === "win32" && (cmd[0] === "npm" || cmd[0] === "npx")) {
    return ["cmd.exe", "/d", "/s", "/c", ...cmd];
  }
  return cmd;
}

/**
 * Run an upgrade shell command synchronously. Kept for callers that only need
 * the exit status; performUpgrade() uses runUpgradeCommand() so it can classify
 * failures from the output.
 */
export function spawnUpgradeCommand(cmd: string[]): SpawnSyncReturns<Buffer> {
  const argv = upgradeCommandArgv(cmd);
  return spawnSync(argv[0]!, argv.slice(1), { stdio: "inherit", env: process.env });
}

/**
 * Run a command with live output AND a captured transcript — we need the text
 * to tell a permission error from a network error, and the user needs to see
 * progress while brew/npm churns.
 */
export function runUpgradeCommand(cmd: string[]): Promise<{ status: number | null; output: string }> {
  const argv = upgradeCommandArgv(cmd);
  return new Promise((resolve) => {
    let output = "";
    const child = spawn(argv[0]!, argv.slice(1), {
      stdio: ["inherit", "pipe", "pipe"],
      env: process.env,
    });
    const tap = (stream: NodeJS.ReadableStream | null, sink: NodeJS.WriteStream) => {
      stream?.on("data", (chunk: Buffer) => {
        const text = chunk.toString();
        output += text;
        sink.write(text);
      });
    };
    tap(child.stdout, process.stdout);
    tap(child.stderr, process.stderr);
    child.on("error", (err) => resolve({ status: null, output: output + String(err.message) }));
    child.on("close", (code) => resolve({ status: code, output }));
  });
}

/**
 * Classify a failed upgrade command from its output. Drives whether we suggest
 * sudo/another channel (permission), retry later (network), or run the
 * uninstall+reinstall repair.
 */
export function classifyUpgradeFailure(output: string, status: number | null): UpgradeFailure {
  const t = output.toLowerCase();
  if (/eacces|eperm|permission denied|operation not permitted|access is denied|administrator/.test(t)) {
    return "permission";
  }
  if (/enotfound|etimedout|econnreset|network|getaddrinfo|proxy|socket hang up|could not resolve host|tls/.test(t)) {
    return "network";
  }
  if (/enoent|command not found|is not recognized|no such file or directory/.test(t)) {
    return "not-found";
  }
  return status === null ? "not-found" : "unknown";
}

/**
 * Every copy of the binary on PATH, in resolution order. Two copies (brew +
 * npm, or a stale `klaatcode-ai` 1.x bin) means the upgrade can land while the
 * shell keeps launching the old one — worth telling the user about explicitly.
 */
export function resolveBinariesOnPath(bin = BIN_NAME): string[] {
  try {
    const res = process.platform === "win32"
      ? spawnSync("where", [bin], { encoding: "utf-8" })
      : spawnSync("which", ["-a", bin], { encoding: "utf-8" });
    if (res.status !== 0 || !res.stdout) return [];
    const seen = new Set<string>();
    return res.stdout.split(/\r?\n/).map(s => s.trim()).filter(Boolean)
      .filter(p => (seen.has(p) ? false : (seen.add(p), true)));
  } catch {
    return [];
  }
}

/**
 * Ask the installed binary what version it is. Runs the first PATH hit (that's
 * what the user's next `klaatcode` will launch), falling back to this process's
 * own executable.
 */
export function readInstalledVersion(): string | null {
  const candidates = [...resolveBinariesOnPath(), process.execPath];
  for (const exe of candidates) {
    try {
      const res = spawnSync(exe, ["--version"], { encoding: "utf-8", timeout: 15_000 });
      const parsed = parseVersionOutput(`${res.stdout ?? ""}${res.stderr ?? ""}`);
      if (parsed) return parsed;
    } catch { /* try the next candidate */ }
  }
  return null;
}

/** Steps that wipe a broken install and put a clean one back. */
export interface RepairPlan {
  label: string;
  /** Directories to delete before reinstalling (installer channel). */
  removeDirs?: string[];
  commands: string[][];
}

/**
 * Uninstall + reinstall recipe per channel. `klaatcode-ai` is the retired 1.x
 * package name; leaving it installed is exactly what shadows the new binary,
 * so the npm repair removes it too (harmless when absent).
 */
export function repairPlanFor(channel: InstallChannel, homeDir = homedir()): RepairPlan | null {
  switch (channel) {
    case "npm":
      return {
        label: "npm reinstall",
        commands: [
          ["npm", "uninstall", "-g", "klaatcode", "klaatcode-ai"],
          ["npm", "cache", "clean", "--force"],
          ["npm", "install", "-g", "klaatcode@latest"],
        ],
      };
    case "brew":
      return {
        label: "Homebrew reinstall",
        commands: [
          ["brew", "uninstall", "--force", "klaatcode"],
          ["brew", "install", "KlaatAI/klaatcode/klaatcode"],
        ],
      };
    case "installer":
      return {
        label: "clean re-run of the install script",
        removeDirs: [join(homeDir, ".klaatcode")],
        commands: [["bash", "-c", "curl -fsSL https://klaatai.com/api/install | bash"]],
      };
    default:
      // source: git; installer-windows: the detached helper reinstalls anyway;
      // unknown: nothing safe to uninstall.
      return null;
  }
}

/**
 * Windows curl/PowerShell installs live at ~/.klaatcode/bin/klaatcode.exe.
 * That binary cannot replace itself — spawn a detached helper that waits for
 * this process to exit, then re-runs the public install script.
 */
export function runDetachedWindowsInstallerUpgrade(): never {
  const ps = windowsPowerShellExe();
  const pid = process.pid;
  const command = [
    "$ErrorActionPreference='Stop'",
    `Write-Host 'Waiting for klaatcode (PID ${pid}) to exit…' -ForegroundColor Gray`,
    `Wait-Process -Id ${pid} -ErrorAction SilentlyContinue`,
    "Start-Sleep -Seconds 1",
    `irm ${INSTALLER_WIN_URL} | iex`,
  ].join("; ");

  const child = spawn(ps, ["-NoProfile", "-ExecutionPolicy", "Bypass", "-Command", command], {
    detached: true,
    stdio: "ignore",
    windowsHide: true,
    env: process.env,
  });
  child.on("error", (err) => {
    process.stderr.write(`\n${RED}✗${RESET} Could not start upgrade helper: ${err.message}\n`);
    process.stderr.write(`${DIM}Run manually: irm ${INSTALLER_WIN_URL} | iex${RESET}\n`);
    process.exit(1);
  });
  if (!child.pid) {
    process.stderr.write(`\n${RED}✗${RESET} Could not start upgrade helper.\n`);
    process.stderr.write(`${DIM}Run manually: irm ${INSTALLER_WIN_URL} | iex${RESET}\n`);
    process.exit(1);
  }
  child.unref();

  process.stdout.write(
    `\n${GREEN}✓${RESET} Upgrade scheduled — it will finish once this process exits.\n` +
    `${DIM}Open a new terminal and run ${BOLD}klaatcode --version${RESET}${DIM} to confirm.${RESET}\n`,
  );
  process.exit(0);
}

/** Hint text for a classified failure. */
function failureHint(failure: UpgradeFailure, channel: InstallChannel): string {
  switch (failure) {
    case "permission":
      return channel === "npm"
        ? "npm's global prefix isn't writable. Either point npm at a user-owned prefix " +
          "(npm config set prefix ~/.npm-global) or install via the script instead: " +
          "curl -fsSL https://klaatai.com/api/install | bash"
        : "The install location isn't writable by this user.";
    case "network":
      return "Could not reach the download servers. Check your connection/proxy and retry.";
    case "not-found":
      return channel === "npm"
        ? "npm isn't on PATH. Install Node.js, or use: curl -fsSL https://klaatai.com/api/install | bash"
        : "The package manager for this install isn't on PATH.";
    case "verify":
      return "The new version installed but an older copy still wins on PATH.";
    default:
      return "";
  }
}

/**
 * Do the actual upgrade and report what happened. Never exits the process —
 * callers (the `upgrade` command, the startup gate) decide what to do next.
 *
 * Sequence: check → channel → upgrade command → verify installed version →
 * repair (uninstall + reinstall) → verify again.
 */
export async function performUpgrade(opts: {
  /** Skip the version check and upgrade unconditionally. */
  info?: { current: string; latest: string };
  /** Suppress progress writes (used by non-interactive callers). */
  quiet?: boolean;
} = {}): Promise<UpgradeOutcome> {
  const say = (s: string) => { if (!opts.quiet) process.stdout.write(s); };
  const channel = detectInstallChannel();

  let target = opts.info;
  if (!target) {
    const info = await checkForUpdate(true);
    if (!info) {
      return {
        ok: false, channel, from: VERSION, failure: "network",
        message: "Could not reach https://klaatai.com/api/latest — check your connection and retry.",
      };
    }
    target = { current: info.current, latest: info.latest };
  }

  if (channel === "source") {
    return {
      ok: false, channel, from: target.current, to: target.latest, failure: "unknown",
      message: "Running from a source checkout — upgrade with: git pull && bun install",
    };
  }
  if (channel === "unknown") {
    return {
      ok: false, channel, from: target.current, to: target.latest, failure: "not-found",
      message: `Could not detect how this copy was installed (${process.execPath}). ` +
               `Upgrade with whichever you used to install:\n  ${MANUAL_COMMANDS.join("\n  ")}`,
      shadowed: resolveBinariesOnPath(),
    };
  }
  if (channel === "installer-windows") {
    // The running .exe cannot replace itself; the helper finishes after exit,
    // so there is nothing to verify here.
    say(`${DIM}Installed via PowerShell installer — scheduling upgrade…${RESET}\n`);
    runDetachedWindowsInstallerUpgrade();
  }

  const { label, cmd } = CHANNEL_COMMANDS[channel];
  say(`${DIM}Installed via ${label} — running:${RESET} ${cmd.join(" ")}\n\n`);

  const res = await runUpgradeCommand(cmd);
  let failure: UpgradeFailure | undefined =
    res.status === 0 ? undefined : classifyUpgradeFailure(res.output, res.status);

  // Zero exit is not proof. Ask the binary.
  let installed = failure ? null : readInstalledVersion();
  if (!failure && installed && compareSemver(installed, target.latest) < 0) failure = "verify";

  if (!failure) {
    clearDismissal();
    return { ok: true, channel, from: target.current, to: target.latest, installed: installed ?? undefined };
  }

  // Permission and not-found are environmental: a reinstall hits the same wall,
  // and `npm uninstall -g` on an unwritable prefix can leave a half-removed
  // install. Report instead of thrashing.
  if (failure === "permission" || failure === "not-found") {
    return {
      ok: false, channel, from: target.current, to: target.latest, failure,
      message: failureHint(failure, channel),
    };
  }

  const plan = repairPlanFor(channel);
  if (!plan) {
    return {
      ok: false, channel, from: target.current, to: target.latest, failure,
      message: `${failureHint(failure, channel)}\nUpgrade manually:\n  ${MANUAL_COMMANDS.join("\n  ")}`,
      shadowed: resolveBinariesOnPath(),
    };
  }

  say(
    `\n${YELLOW}⚠${RESET} ${failure === "verify"
      ? `Upgrade ran but ${BIN_NAME} still reports v${installed ?? "?"}.`
      : "Upgrade command failed."} Trying a clean ${plan.label}…\n\n`,
  );

  for (const dir of plan.removeDirs ?? []) {
    try { rmSync(dir, { recursive: true, force: true }); }
    catch (e) { say(`${DIM}Could not remove ${dir}: ${e instanceof Error ? e.message : String(e)}${RESET}\n`); }
  }

  let repairFailure: UpgradeFailure | undefined;
  for (const step of plan.commands) {
    say(`${DIM}$ ${step.join(" ")}${RESET}\n`);
    const r = await runUpgradeCommand(step);
    // Uninstall steps are allowed to fail (nothing installed under that name);
    // only the final install step is load-bearing.
    const isLast = step === plan.commands[plan.commands.length - 1];
    if (r.status !== 0 && isLast) repairFailure = classifyUpgradeFailure(r.output, r.status);
  }

  installed = readInstalledVersion();
  const shadowed = resolveBinariesOnPath();
  const verified = !!installed && compareSemver(installed, target.latest) >= 0;

  if (verified && !repairFailure) {
    clearDismissal();
    return {
      ok: true, repaired: true, channel, from: target.current, to: target.latest,
      installed: installed ?? undefined, shadowed,
    };
  }

  const finalFailure = repairFailure ?? "verify";
  const shadowNote = shadowed.length > 1
    ? `\nMultiple copies of ${BIN_NAME} are on PATH — the first one wins:\n  ${shadowed.join("\n  ")}\n` +
      "Remove the stale one(s), then re-run: klaatcode upgrade"
    : "";
  return {
    ok: false, repaired: true, channel, from: target.current, to: target.latest,
    installed: installed ?? undefined, failure: finalFailure,
    message: `${failureHint(finalFailure, channel)}${shadowNote}\nUpgrade manually:\n  ${MANUAL_COMMANDS.join("\n  ")}`,
    shadowed,
  };
}

/** Print an outcome in the CLI's voice. Shared by `upgrade` and the startup gate. */
export function printUpgradeOutcome(o: UpgradeOutcome): void {
  if (o.ok) {
    const via = o.repaired ? " (after a clean reinstall)" : "";
    process.stdout.write(`\n${GREEN}✓${RESET} Upgraded to v${o.installed ?? o.to}${via}.\n`);
    return;
  }
  process.stderr.write(`\n${RED}✗${RESET} Upgrade did not complete.\n`);
  if (o.message) process.stderr.write(`${DIM}${o.message}${RESET}\n`);
}

/** Entry point for `klaatcode upgrade [--check]`. Exits the process. */
export async function runUpgrade(opts: { check?: boolean } = {}): Promise<never> {
  process.stdout.write(`${DIM}Current version:${RESET} v${VERSION}\n`);
  process.stdout.write(`${DIM}Checking latest…${RESET}\n`);

  const info = await checkForUpdate(true);
  if (!info) {
    process.stderr.write(`${RED}✗${RESET} Could not reach https://klaatai.com/api/latest — check your connection and retry.\n`);
    process.exit(1);
  }

  if (!info.updateAvailable) {
    process.stdout.write(`${GREEN}✓${RESET} Up to date — running v${info.current}, latest release v${info.latest}.\n`);
    const dupes = resolveBinariesOnPath();
    if (dupes.length > 1) {
      process.stdout.write(
        `${YELLOW}⚠${RESET} More than one ${BIN_NAME} on PATH — the first wins:\n  ${dupes.join("\n  ")}\n`,
      );
    }
    process.exit(0);
  }

  process.stdout.write(`${CYAN}Update available:${RESET} v${info.current} → ${BOLD}v${info.latest}${RESET}\n`);
  if (info.notes) process.stdout.write(`${DIM}${info.notes}${RESET}\n`);
  if (info.mandatory) {
    process.stdout.write(
      `${YELLOW}This release is required${RESET} — versions below v${info.minSupported} are no longer supported.\n`,
    );
  }
  if (opts.check) process.exit(0);

  const outcome = await performUpgrade({ info: { current: info.current, latest: info.latest } });
  printUpgradeOutcome(outcome);
  if (!outcome.ok) process.exit(1);
  process.stdout.write(`${DIM}Restart klaatcode to use the new version.${RESET}\n`);
  process.exit(0);
}
