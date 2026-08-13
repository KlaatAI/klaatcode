/**
 * Startup update gate — the thing that runs before anything else when a user
 * types `klaatcode`.
 *
 * Flow:
 *   1. Cached check (4h, fail-silent — offline never blocks a launch).
 *   2. Up to date → return immediately.
 *   3. Below the server's `minSupported` floor → MANDATORY: upgrade without
 *      asking, and stop if it cannot be installed (an unsupported client gets
 *      rejected by the gateway anyway). KLAATAI_SKIP_VERSION_GATE=1 overrides.
 *   4. Otherwise → ask "Update now? [Y/n]". "n" is remembered per version so
 *      the same release never nags twice.
 *   5. After a successful upgrade, re-exec the new binary with the original
 *      arguments so the user lands where they were going.
 *
 * Non-interactive contexts (pipes, CI, `--no-update-check`, KLAATAI_NO_UPDATE=1)
 * never prompt: they print one line to stderr and continue.
 */

import { spawnSync } from "node:child_process";
import { createInterface } from "node:readline";
import { checkForUpdate, dismissUpdate, isUpdateDismissed, type UpdateInfo } from "../utils/update.js";
import {
  BIN_NAME, MANUAL_COMMANDS, detectInstallChannel, performUpgrade,
  printUpgradeOutcome, resolveBinariesOnPath,
} from "./upgrade.js";

const BOLD = "\x1b[1m", DIM = "\x1b[2m", CYAN = "\x1b[36m", YELLOW = "\x1b[33m", RESET = "\x1b[0m";

export type GateAction =
  /** Do nothing — up to date, disabled, or already declined. */
  | "skip"
  /** Ask the user, default yes. */
  | "prompt"
  /** Upgrade without asking; refuse to continue if it fails. */
  | "mandatory"
  /** Can't prompt (non-TTY) but there IS an update — print a one-line notice. */
  | "notify";

export interface GateEnv {
  /** stdin AND stdout are a terminal — anything else means no prompting. */
  interactive: boolean;
  /** `--no-update-check`, config, or env opt-out. */
  disabled: boolean;
  /** Running from a git checkout (`bun run src/main.tsx`) — never self-update. */
  source: boolean;
  /** KLAATAI_SKIP_VERSION_GATE=1 — let an unsupported version run anyway. */
  skipFloor: boolean;
  /** The user already said no to this exact version. */
  dismissed: boolean;
}

/** Pure decision so the policy is unit-testable without a terminal. */
export function decideUpdateAction(info: UpdateInfo | null, env: GateEnv): GateAction {
  if (!info || !info.updateAvailable) return "skip";
  if (env.source) return "skip";
  if (info.mandatory && !env.skipFloor) {
    // The floor is a hard stop, so it ignores `disabled` and the dismissal —
    // but it still needs a terminal to run an installer that may prompt.
    return env.interactive ? "mandatory" : "notify";
  }
  if (env.disabled) return "skip";
  if (!env.interactive) return "notify";
  if (env.dismissed) return "skip";
  return "prompt";
}

/** Env/flags → GateEnv. */
export function readGateEnv(opts: { noUpdateCheck?: boolean; latest?: string } = {}): GateEnv {
  const env = process.env;
  const optedOut =
    opts.noUpdateCheck === true ||
    env["KLAATAI_NO_UPDATE"] === "1" ||
    env["KLAATAI_UPDATE_CHECK"] === "off" ||
    // Standard CI markers: an unattended run must never stall on a prompt.
    !!env["CI"] || !!env["GITHUB_ACTIONS"] || !!env["BUILDKITE"] || !!env["TEAMCITY_VERSION"];

  return {
    interactive: !!process.stdin.isTTY && !!process.stdout.isTTY,
    disabled: optedOut,
    source: detectInstallChannel() === "source",
    skipFloor: env["KLAATAI_SKIP_VERSION_GATE"] === "1",
    dismissed: !!opts.latest && isUpdateDismissed(opts.latest),
  };
}

/** One-line y/n question on the raw terminal (the TUI has not started yet). */
export async function askYesNo(question: string, defaultYes = true): Promise<boolean> {
  return new Promise((resolve) => {
    const rl = createInterface({ input: process.stdin, output: process.stdout });
    rl.question(question, (answer) => {
      rl.close();
      const a = answer.trim().toLowerCase();
      if (!a) return resolve(defaultYes);
      resolve(a === "y" || a === "yes");
    });
  });
}

/**
 * Replace this process with the freshly installed binary, same arguments.
 * Returns only if re-exec was impossible (then the caller keeps running the
 * old code, which is still better than dying at the finish line).
 */
function reExec(): void {
  if (process.env["KLAATAI_NO_REEXEC"] === "1") return;
  const bin = resolveBinariesOnPath()[0];
  if (!bin) return;
  const args = process.argv.slice(2);
  process.stdout.write(`${DIM}Restarting ${BIN_NAME}…${RESET}\n`);
  const res = spawnSync(bin, args, { stdio: "inherit", env: process.env });
  process.exit(res.status ?? 0);
}

/**
 * Run the gate. Resolves when it is safe to continue in THIS process; calls
 * process.exit() when it re-execs the new version or refuses an unsupported one.
 */
export async function runUpdateGate(opts: { noUpdateCheck?: boolean; neverPrompt?: boolean } = {}): Promise<void> {
  // A fully disabled, non-mandatory setup shouldn't even read the cache file —
  // but the floor must still be enforced, so only the "source" case short-circuits.
  if (detectInstallChannel() === "source") return;

  let info: UpdateInfo | null = null;
  try { info = await checkForUpdate(); } catch { return; }
  if (!info) return;

  const env = readGateEnv({ ...opts, latest: info.latest });
  // `klaatcode run` is scripted usage even from a terminal — notify, never stall.
  if (opts.neverPrompt) env.interactive = false;
  const action = decideUpdateAction(info, env);
  if (action === "skip") return;

  const headline = `${CYAN}Update available:${RESET} v${info.current} → ${BOLD}v${info.latest}${RESET}`;

  if (action === "notify") {
    process.stderr.write(
      `${headline}${info.mandatory ? `  ${YELLOW}(required — v${info.minSupported}+ only)${RESET}` : ""}\n` +
      `${DIM}Run \`${BIN_NAME} upgrade\` to update.${RESET}\n`,
    );
    return;
  }

  process.stdout.write(`\n${headline}\n`);
  if (info.notes) process.stdout.write(`${DIM}${info.notes}${RESET}\n`);

  if (action === "prompt") {
    const yes = await askYesNo(`${DIM}Update now?${RESET} [${BOLD}Y${RESET}/n] `, true);
    if (!yes) {
      dismissUpdate(info.latest);
      process.stdout.write(`${DIM}Skipped — run \`${BIN_NAME} upgrade\` whenever you like.${RESET}\n`);
      return;
    }
  } else {
    process.stdout.write(
      `${YELLOW}This release is required${RESET} — versions below v${info.minSupported} are no longer supported.\n` +
      `${DIM}Updating now (set KLAATAI_SKIP_VERSION_GATE=1 to bypass at your own risk).${RESET}\n`,
    );
  }

  const outcome = await performUpgrade({ info: { current: info.current, latest: info.latest } });
  printUpgradeOutcome(outcome);

  if (outcome.ok) {
    reExec();
    return; // re-exec unavailable — carry on with the running copy
  }

  if (action === "mandatory") {
    process.stderr.write(
      `\n${YELLOW}Cannot continue on v${info.current}${RESET} — it is below the supported floor ` +
      `v${info.minSupported}.\nInstall manually, then retry:\n  ${MANUAL_COMMANDS.join("\n  ")}\n` +
      `${DIM}To run anyway: KLAATAI_SKIP_VERSION_GATE=1 ${BIN_NAME}${RESET}\n`,
    );
    process.exit(1);
  }

  process.stdout.write(`${DIM}Continuing on v${info.current}.${RESET}\n`);
}
