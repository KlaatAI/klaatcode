/**
 * Pre-boot session picker — full-screen interactive list with search, shown
 * when the user runs `klaatcode -r` without an id.
 *
 * This runs BEFORE the TUI engine starts and drives stdin directly, so it must
 * hand the terminal back exactly as it found it. Leaving its `data` listener
 * attached is not a cosmetic leak: the listener survives into the TUI session,
 * sees every keystroke alongside InputParser, and the first Enter re-runs
 * cleanup — `setRawMode(false)` + `stdin.pause()` — which deafens the whole app
 * with no visible cause. `cleanup()` is therefore idempotent and always
 * detaches. `session-picker.test.ts` locks this down.
 */

import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { homedir } from "node:os";

export interface SessionChoice {
  id: string;
  date: string;
  preview: string;
}

/** Minimal stdin surface the picker needs — lets tests drive it without a tty. */
export interface PickerStdin {
  setRawMode(raw: boolean): unknown;
  resume(): unknown;
  pause(): unknown;
  setEncoding(enc: string): unknown;
  on(event: "data", cb: (key: string) => void): unknown;
  removeListener(event: "data", cb: (key: string) => void): unknown;
}

export interface PickerStdout {
  write(s: string): unknown;
  rows?: number | undefined;
  columns?: number | undefined;
}

/** Read the most recent saved sessions, newest first. */
export function listSessionChoices(sessionDir = join(homedir(), ".klaatai", "sessions")): SessionChoice[] {
  try {
    return readdirSync(sessionDir)
      .filter(f => f.endsWith(".jsonl"))
      .sort().reverse().slice(0, 50)
      .map(f => {
        const id = f.replace(".jsonl", "");
        const date = id.slice(0, 16).replace("T", " ").replace(/-/g, (_m, i) => i < 10 ? "-" : ":");
        try {
          // Stop at the first user message — transcripts reach tens of MB and
          // parsing every line of every session just to build a preview made
          // `-r` take seconds to open.
          let preview = "(empty)";
          for (const line of readFileSync(join(sessionDir, f), "utf-8").split("\n")) {
            if (!line.trim()) continue;
            const m = JSON.parse(line) as { role?: string; content?: string };
            if (m.role === "user") { preview = (m.content ?? "(empty)").slice(0, 80); break; }
          }
          return { id, date, preview };
        } catch {
          return { id, date, preview: "(unreadable)" };
        }
      });
  } catch {
    return [];
  }
}

/** Filter sessions by a free-text query over preview / id / date. */
export function filterSessions(sessions: SessionChoice[], query: string): SessionChoice[] {
  if (!query) return sessions;
  const q = query.toLowerCase();
  return sessions.filter(s =>
    s.preview.toLowerCase().includes(q) || s.id.includes(q) || s.date.includes(q));
}

export interface PickerOpts {
  stdin?: PickerStdin;
  stdout?: PickerStdout;
  sessions?: SessionChoice[];
}

/**
 * Show the picker and resolve with the chosen session id, or null to start
 * fresh (no sessions, Esc, or Ctrl+C).
 */
export async function runSessionPicker(opts: PickerOpts = {}): Promise<string | null> {
  const stdin  = (opts.stdin  ?? process.stdin) as PickerStdin;
  const stdout = (opts.stdout ?? process.stdout) as PickerStdout;
  const sessions = opts.sessions ?? listSessionChoices();

  if (sessions.length === 0) {
    stdout.write("\x1b[2mNo saved sessions found. Starting fresh.\x1b[0m\n");
    return null;
  }

  stdin.setRawMode(true);
  stdin.resume();
  stdin.setEncoding("utf-8");

  let cursor = 0;
  let search = "";
  let filtered = sessions;

  function render(): void {
    stdout.write("\x1b[2J\x1b[H"); // clear screen, cursor to top
    const dim = "\x1b[2m";
    const reset = "\x1b[0m";
    const bold = "\x1b[1m";
    const cyan = "\x1b[36m";
    const accent = "\x1b[38;5;141m";
    const white = "\x1b[37m";

    stdout.write(`${accent}${bold}  ⏵ Resume Session${reset}\n`);
    stdout.write(`${dim}  ─────────────────────────────────────────${reset}\n`);
    stdout.write(`  ${cyan}Search:${reset} ${search}${dim}│${reset}\n`);
    stdout.write(`${dim}  ─────────────────────────────────────────${reset}\n\n`);

    const rows = Math.min(filtered.length, (stdout.rows || 24) - 8);
    const start = Math.max(0, cursor - rows + 3);
    for (let i = start; i < start + rows && i < filtered.length; i++) {
      const s = filtered[i]!;
      const isFocused = i === cursor;
      const marker = isFocused ? `${accent}❯${reset}` : " ";
      const datePart = s.date.slice(5, 16);
      const previewPart = s.preview.slice(0, (stdout.columns || 80) - 25);
      if (isFocused) {
        stdout.write(`  ${marker} ${bold}${white}${datePart}${reset}  ${previewPart}\n`);
      } else {
        stdout.write(`  ${marker} ${dim}${datePart}${reset}  ${dim}${previewPart}${reset}\n`);
      }
    }

    stdout.write(`\n${dim}  ↑↓ navigate · enter select · esc start fresh · type to search${reset}\n`);
  }

  render();

  return new Promise<string | null>((resolveP) => {
    let settled = false;

    function cleanup(): void {
      if (settled) return;
      settled = true;
      stdin.removeListener("data", onKey);
      stdin.setRawMode(false);
      stdin.pause();
      stdout.write("\x1b[2J\x1b[H"); // clear screen
    }

    function onKey(key: string): void {
      if (settled) return;
      if (key === "\x1b" || key === "\x03") {
        cleanup();
        resolveP(null);           // Esc / Ctrl+C — start fresh
        return;
      }
      if (key === "\r" || key === "\n") {
        cleanup();
        resolveP(filtered[cursor]?.id ?? null);
        return;
      }
      if (key === "\x1b[A") {
        cursor = Math.max(0, cursor - 1);
        render();
        return;
      }
      if (key === "\x1b[B") {
        cursor = Math.min(filtered.length - 1, cursor + 1);
        render();
        return;
      }
      if (key === "\x7f" || key === "\b") {
        search = search.slice(0, -1);
        filtered = filterSessions(sessions, search);
        cursor = 0;
        render();
        return;
      }
      if (key.length === 1 && key.charCodeAt(0) >= 32) {
        search += key;
        filtered = filterSessions(sessions, search);
        cursor = 0;
        render();
      }
    }

    stdin.on("data", onKey);
  });
}
