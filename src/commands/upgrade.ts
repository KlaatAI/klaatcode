/**
 * `klaatai upgrade` — self-update through whichever channel installed us.
 *
 * Channel detection is path-based on the resolved binary location:
 *   node_modules/ | .bun/install/  → npm  (npm i -g klaatcode@latest)
 *   Cellar/ | linuxbrew/            → brew (brew upgrade klaatcode)
 *   ~/.klaatcode/                   → curl / PowerShell installer (re-run it)
 *   running via bun src/            → source checkout (git pull)
 *
 * Windows notes:
 *   - npm must run through cmd.exe (npm is a .cmd shim — bare spawnSync fails).
 *   - The PowerShell installer cannot overwrite klaatcode.exe while it is
 *     running, so we spawn a detached helper that waits for this PID to exit
 *     and then re-runs the install script.
 */

import { spawn, spawnSync, type SpawnSyncReturns } from "node:child_process";
import { realpathSync } from "node:fs";
import { homedir } from "node:os";
import { basename, join } from "node:path";
import { checkForUpdate } from "../utils/update.js";
import { version as VERSION } from "../../package.json";

export type InstallChannel =
  | "npm"
  | "brew"
  | "installer"          // curl -fsSL klaatai.com/api/install | bash
  | "installer-windows"  // irm klaatai.com/api/install-windows | iex
  | "source"
  | "unknown";

const INSTALLER_WIN_URL = "https://klaatai.com/api/install-windows";

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

const BOLD = "\x1b[1m", DIM = "\x1b[2m", CYAN = "\x1b[36m", GREEN = "\x1b[32m", YELLOW = "\x1b[33m", RED = "\x1b[31m", RESET = "\x1b[0m";

/** Absolute path to Windows PowerShell — avoids PATH issues on Server Core etc. */
export function windowsPowerShellExe(): string {
  const root = process.env.SystemRoot ?? process.env.WINDIR ?? "C:\\Windows";
  return join(root, "System32", "WindowsPowerShell", "v1.0", "powershell.exe");
}

/**
 * Run an upgrade shell command. On Windows, npm/go.cmd shims need cmd.exe —
 * bare spawnSync("npm", …) fails with ENOENT/spawn EINVAL.
 */
export function spawnUpgradeCommand(cmd: string[]): SpawnSyncReturns<Buffer> {
  if (process.platform === "win32" && cmd[0] === "npm") {
    return spawnSync("cmd.exe", ["/d", "/s", "/c", "npm", ...cmd.slice(1)], {
      stdio: "inherit",
      env: process.env,
    });
  }
  return spawnSync(cmd[0]!, cmd.slice(1), { stdio: "inherit", env: process.env });
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

/** Entry point for `klaatai upgrade [--check]`. Exits the process. */
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
    process.exit(0);
  }

  process.stdout.write(`${CYAN}Update available:${RESET} v${info.current} → ${BOLD}v${info.latest}${RESET}\n`);
  if (opts.check) process.exit(0);

  const channel = detectInstallChannel();

  if (channel === "source") {
    process.stdout.write(`\nRunning from a source checkout — upgrade with:\n  ${BOLD}git pull && bun install${RESET}\n`);
    process.exit(0);
  }
  if (channel === "unknown") {
    process.stdout.write(
      `\n${YELLOW}⚠${RESET} Could not detect how this copy was installed (${DIM}${process.execPath}${RESET}).\n` +
      `Upgrade manually with whichever you used to install:\n` +
      `  npm i -g klaatcode@latest\n` +
      `  brew upgrade KlaatAI/klaatcode/klaatcode\n` +
      `  curl -fsSL https://klaatai.com/api/install | bash\n` +
      `  irm https://klaatai.com/api/install-windows | iex\n`,
    );
    process.exit(1);
  }

  if (channel === "installer-windows") {
    process.stdout.write(`${DIM}Installed via PowerShell installer — scheduling upgrade…${RESET}\n`);
    runDetachedWindowsInstallerUpgrade();
  }

  const { label, cmd } = CHANNEL_COMMANDS[channel];
  process.stdout.write(`${DIM}Installed via ${label} — running:${RESET} ${cmd.join(" ")}\n\n`);

  const res = spawnUpgradeCommand(cmd);
  if (res.error) {
    const hint = process.platform === "win32" && cmd[0] === "npm"
      ? `\n${DIM}Tip: ensure Node.js/npm is on your PATH, or run manually: npm install -g klaatcode@latest${RESET}\n`
      : "";
    process.stderr.write(`\n${RED}✗${RESET} Upgrade command failed: ${res.error.message}.${hint}\n`);
    process.exit(1);
  }
  if (res.status !== 0) {
    process.stderr.write(`\n${RED}✗${RESET} Upgrade command failed (exit ${res.status}).\n`);
    process.exit(res.status ?? 1);
  }

  process.stdout.write(`\n${GREEN}✓${RESET} Upgraded to v${info.latest}. Restart klaatcode to use the new version.\n`);
  process.exit(0);
}
