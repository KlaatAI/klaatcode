/**
 * Background shells — run long commands (dev servers, watchers, test suites)
 * without blocking the agent loop. `run_command background:true` starts one and
 * returns an id; `shell_output` polls new output; `shell_kill` stops it.
 */

import { spawn, type ChildProcess } from "node:child_process";
import { shellCommand } from "./shell.js";

interface BgShell {
  id: string;
  command: string;
  proc: ChildProcess;
  buf: string;        // accumulated output
  readOffset: number; // chars already returned to the model
  done: boolean;
  exitCode: number | null;
  startedAt: number;
}

const MAX_BUF = 200_000; // cap per-shell buffer to avoid unbounded memory
const shells = new Map<string, BgShell>();
let counter = 0;

/** Start a command in the background. Returns its id. */
export function startBackground(command: string, cwd: string): string {
  const id = `sh-${++counter}`;
  const sh = shellCommand(command);
  const proc = spawn(sh.exe, sh.args, { cwd });
  const s: BgShell = { id, command, proc, buf: "", readOffset: 0, done: false, exitCode: null, startedAt: Date.now() };

  const append = (chunk: Buffer) => {
    s.buf += chunk.toString("utf-8");
    if (s.buf.length > MAX_BUF) s.buf = s.buf.slice(s.buf.length - MAX_BUF);
  };
  proc.stdout?.on("data", append);
  proc.stderr?.on("data", append);
  proc.on("exit", (code) => { s.done = true; s.exitCode = code ?? 0; });
  proc.on("error", (e) => { s.buf += `\n[spawn error: ${e.message}]`; s.done = true; s.exitCode = -1; });

  shells.set(id, s);
  return id;
}

/** New output since the last poll + status. */
export function readBackground(id: string): string {
  const s = shells.get(id);
  if (!s) return `Error: no background shell "${id}". Use shell_output only with an id from run_command.`;
  const fresh = s.buf.slice(s.readOffset);
  s.readOffset = s.buf.length;
  const status = s.done ? `[exited ${s.exitCode}]` : "[running]";
  const body = fresh.trim() || "(no new output)";
  return `${status} ${id}: ${s.command}\n${body}`;
}

/** Kill a background shell. */
export function killBackground(id: string): string {
  const s = shells.get(id);
  if (!s) return `Error: no background shell "${id}".`;
  if (s.done) return `Shell ${id} already exited (${s.exitCode}).`;
  try { s.proc.kill("SIGTERM"); } catch { /* */ }
  s.done = true;
  return `Killed background shell ${id}.`;
}

/** Short status list of all background shells (for /agents-style display). */
export function listBackground(): { id: string; command: string; done: boolean; exitCode: number | null }[] {
  return [...shells.values()].map(s => ({ id: s.id, command: s.command, done: s.done, exitCode: s.exitCode }));
}

/** Kill everything (session teardown). */
export function killAllBackground(): void {
  for (const s of shells.values()) { if (!s.done) { try { s.proc.kill("SIGKILL"); } catch { /* */ } } }
  shells.clear();
}
