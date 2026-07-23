/**
 * Routing-tier metadata shared across the REPL: per-tier cost estimates,
 * context windows, display colors, and product names.
 */

/** [inputPerMTok, outputPerMTok] in USD — for client-side cost display only. */
export const TIER_COSTS: Record<string, [number, number]> = {
  nano:   [0.10, 0.20],
  fast:   [0.25, 0.75],
  code:   [0.50, 1.50],
  reason: [1.00, 3.00],
  heavy:  [2.50, 8.00],
  flash:  [0.25, 0.75],
  core:   [0.60, 2.00],
  beast:  [2.50, 8.00],
};

export const VALID_TIERS = new Set(["nano", "fast", "code", "reason", "heavy"]);

// Context window sizes by tier — MUST match the brain's per-tier input budget
// (Klaatu api/context_engine.py _EDITOR_OVERFLOW_GUARDS), since the CLI sends
// `X-KlaatAI-Compaction: client` and the brain then trims to that guard. A
// larger client guess causes a double-trim (client compacts to its number,
// brain trims again to its lower number) → extra amnesia. Keep in lock-step.
//   Brain overflow guards (2026-07-23): nano 14K · fast 40K · code 200K ·
//   reason 125K (R1 160K − 32K output ceiling) · heavy 200K.
export const TIER_CONTEXT_WINDOW: Record<string, number> = {
  nano:    14_000,
  fast:    40_000,
  code:   200_000,
  reason: 125_000,
  heavy:  200_000,
  flash:   40_000,   // alias of fast
  core:   200_000,
  beast:  200_000,
  search: 118_000,
};

// Fraction of the active tier window at which real (LLM) compaction fires.
// Replaces the old fixed SAFE_CONTEXT_BUDGET (60K), which never triggered on
// small tiers whose window is < 60K (fast 28K) — compaction was dead code there.
export const COMPACT_TRIGGER_RATIO = 0.78;

// Retained for callers that still reference an absolute floor; compaction now
// keys off COMPACT_TRIGGER_RATIO × getContextWindow() instead.
export const SAFE_CONTEXT_BUDGET = 60_000;

/** 256-color codes for tier badges. */
export const TIER_COLOR_MAP: Record<string, number | string> = {
  nano: 250, fast: 87, code: 75, reason: 213,
  heavy: 204, flash: 87, core: 75, beast: 204,
  smart: 228,
};

/** Product-facing model name per tier. */
export const KLAATU_MODEL_MAP: Record<string, string> = {
  nano:   "Klaatu Nano",
  fast:   "Klaatu Flash",
  code:   "Klaatu Core",
  reason: "Klaatu Reason",
  heavy:  "Klaatu Ultra",
  flash:  "Klaatu Flash",
  core:   "Klaatu Core",
  beast:  "Klaatu Ultra",
  smart:  "Klaatu Auto",
};

export function formatTok(n: number): string {
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(1)}M`;
  if (n >= 1_000) return `${(n / 1_000).toFixed(1)}K`;
  return `${n}`;
}

export function formatElapsed(seconds: number): string {
  if (seconds >= 60) {
    const m = Math.floor(seconds / 60);
    const s = seconds % 60;
    return s > 0 ? `${m}m ${s}s` : `${m}m`;
  }
  return `${seconds}s`;
}
