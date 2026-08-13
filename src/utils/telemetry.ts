/**
 * Client-side Layer 1 event emitter.
 *
 * The gateway already records everything it can observe for itself — routing
 * decisions, dispatches, cost, and the agent-loop metrics it reads straight out of
 * the message array. This emitter carries ONLY what the server structurally cannot
 * see: the repo fingerprint, and (from week 2) execution outcomes — whether tests
 * passed, whether the user kept the edit or reverted it.
 *
 * Those outcomes are the strongest training labels available, which is the whole
 * reason this file exists.
 *
 * DESIGN RULES
 *   - Never block. `emit()` returns immediately; flushing is out of band.
 *   - Never throw. A telemetry fault must not be able to fail a user's command.
 *   - Survive exit. The queue is on disk, because a CLI process ends constantly and
 *     an in-memory buffer would lose the run that just finished — usually the
 *     interesting one.
 *   - Bounded. Hard cap with oldest-dropped, so a logging bug cannot fill a disk.
 *   - Opt-out is absolute. KLAATAI_TELEMETRY=0, DO_NOT_TRACK=1 or
 *     `"telemetry": "off"` in ~/.klaatai/config.json means nothing is written to
 *     disk and nothing is sent. Reuses the existing check in client-identity.ts —
 *     one opt-out for the whole CLI, not a second one users have to discover.
 *
 * PRIVACY: metadata only. No prompt text, no file contents, no file paths, no repo
 * name. The server enforces the same rule again, and the table has a CHECK
 * constraint behind that — but the first line of defence is not sending it.
 */

import { randomUUID } from "node:crypto";
import { appendFileSync, mkdirSync, readFileSync, renameSync, rmSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { clientIdentity, telemetryEnabled } from "./client-identity.js";

const DIR = join(homedir(), ".klaatai");
const QUEUE = join(DIR, "telemetry-queue.jsonl");

/** Bump when payload semantics change. Must match api/telemetry.py SCHEMA_VERSION. */
const SCHEMA_VERSION = "0.1";

const FLUSH_AT_EVENTS = 50;
const FLUSH_INTERVAL_MS = 10_000;
const MAX_QUEUED = 5_000;
/** ~2MB of metadata is already far past useful; refuse to grow beyond it. */
const MAX_QUEUE_BYTES = 2 * 1024 * 1024;
const POST_TIMEOUT_MS = 8_000;

export interface KlaatEvent {
  event_id?: string;
  event_type: string;
  schema_version?: string;
  client_ts?: string;
  session_id?: string | null;
  project_id?: string | null;
  request_id?: string | null;
  dispatch_id?: string | null;
  surface_version?: string;
  payload?: Record<string, unknown>;
}

let _pending = 0;
let _timer: ReturnType<typeof setInterval> | null = null;
let _flushing = false;
let _sender: (() => { baseUrl: string; token: string } | null) | null = null;

/**
 * Tell the emitter how to reach the API. Called once after auth is resolved;
 * without it, events still queue to disk and go out on a later run.
 */
export function configureTelemetry(
  resolve: () => { baseUrl: string; token: string } | null,
): void {
  _sender = resolve;
  if (!_timer && telemetryEnabled()) {
    _timer = setInterval(() => { void flushTelemetry(); }, FLUSH_INTERVAL_MS);
    // Do not hold the process open just to flush — the exit hook handles the tail.
    _timer.unref?.();
  }
}

/** Queue one event. Never throws, never awaits, never blocks. */
export function emit(event: KlaatEvent): void {
  if (!telemetryEnabled()) return;
  try {
    const id = clientIdentity();
    const line = JSON.stringify({
      event_id: event.event_id ?? randomUUID(),
      event_type: event.event_type,
      schema_version: event.schema_version ?? SCHEMA_VERSION,
      client_ts: event.client_ts ?? new Date().toISOString(),
      session_id: event.session_id ?? null,
      project_id: event.project_id ?? null,
      request_id: event.request_id ?? null,
      dispatch_id: event.dispatch_id ?? null,
      surface_version: event.surface_version ?? id.version,
      payload: event.payload ?? {},
    });

    mkdirSync(DIR, { recursive: true, mode: 0o700 });
    // Refuse to grow without bound. Dropping the whole backlog is the right call
    // over trimming line by line: if it got this big, nothing has flushed in a
    // very long time and the stale head is the least valuable part.
    try {
      if (statSync(QUEUE).size > MAX_QUEUE_BYTES) rmSync(QUEUE, { force: true });
    } catch { /* no queue yet */ }

    appendFileSync(QUEUE, line + "\n", { mode: 0o600 });
    _pending++;
    if (_pending >= FLUSH_AT_EVENTS) void flushTelemetry();
  } catch {
    // Read-only home, full disk, bad JSON: stay silent. Telemetry is never worth
    // a user-visible error.
  }
}

/**
 * Ship whatever is queued. Safe to call any time; concurrent calls no-op.
 *
 * The queue file is RENAMED before reading, so events emitted during the POST land
 * in a fresh file rather than being lost when the old one is deleted.
 */
export async function flushTelemetry(): Promise<void> {
  if (_flushing || !telemetryEnabled()) return;
  const target = _sender?.();
  if (!target?.token || !target.baseUrl) return;

  _flushing = true;
  const inflight = `${QUEUE}.${process.pid}.sending`;
  try {
    try {
      renameSync(QUEUE, inflight);
    } catch {
      return; // nothing queued
    }
    _pending = 0;

    const events = readFileSync(inflight, "utf-8")
      .split("\n")
      .filter(Boolean)
      .slice(-MAX_QUEUED)
      .map((l) => { try { return JSON.parse(l) as unknown; } catch { return null; } })
      .filter(Boolean);

    if (events.length === 0) {
      rmSync(inflight, { force: true });
      return;
    }

    // 200 is the server's per-batch cap (TelemetryBatchIn).
    for (let i = 0; i < events.length; i += 200) {
      const batch = events.slice(i, i + 200);
      const res = await fetch(`${target.baseUrl.replace(/\/$/, "")}/v1/events`, {
        method: "POST",
        headers: {
          "Authorization": `Bearer ${target.token}`,
          "Content-Type": "application/json",
          "X-KlaatAI-Client": "klaatcode",
        },
        body: JSON.stringify({ events: batch }),
        signal: AbortSignal.timeout(POST_TIMEOUT_MS),
      });
      // 4xx means the server will never accept these (bad schema, revoked auth).
      // Retrying forever would pin a growing queue against a permanent error, so
      // drop them. 5xx and network faults fall through to the catch and are kept.
      if (!res.ok && res.status >= 500) throw new Error(`HTTP ${res.status}`);
    }
    rmSync(inflight, { force: true });
  } catch {
    // Transient failure: put the batch back so the next run retries it. Events
    // queued meanwhile are in the new QUEUE file and are not disturbed.
    try {
      const kept = readFileSync(inflight, "utf-8");
      appendFileSync(QUEUE, kept, { mode: 0o600 });
      rmSync(inflight, { force: true });
    } catch { /* nothing recoverable */ }
  } finally {
    _flushing = false;
  }
}

/**
 * Best-effort flush on exit. A CLI run is short, so without this the events from
 * the run that just happened would sit on disk until the next one.
 */
export function installTelemetryExitHook(): void {
  if (!telemetryEnabled()) return;
  const bye = () => { void flushTelemetry(); };
  process.once("beforeExit", bye);
  process.once("SIGINT", bye);
  process.once("SIGTERM", bye);
}

/** Test seam. */
export function _telemetryQueuePath(): string { return QUEUE; }
