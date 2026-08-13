/**
 * Routing-tier metadata shared across the REPL: per-tier cost estimates,
 * context windows, display colors, and product names.
 */

/**
 * [inputPerMTok, outputPerMTok] in USD — what the gateway CHARGES for the tier.
 *
 * Re-exported from ../pricing, which reads the generated `src/data/tier-pricing.json`
 * (mirror of the repo-root canonical file). The hand-typed table that used to live here
 * disagreed with the gateway on nano/code/reason and under-reported user spend by 38–50%.
 * Do not reintroduce literals — edit the root tier-pricing.json and run
 * `python3 scripts/sync_tier_pricing.py`.
 */
import tierPricing from "../data/tier-pricing.json";

export {
  TIER_COSTS,
  TIER_WEIGHTS,
  PREMIUM_TIERS,
  costUsd,
  isExplicitOnly,
  monthlyResetLabel,
  premiumCaps,
  tierCap,
  tierLabel,
  tierUnitCost,
  tierUnitCostLabel,
  tierWeight,
  unitsScaleWithSize,
} from "../pricing";

export const VALID_TIERS = new Set(["nano", "fast", "code", "reason", "heavy", "titan"]);

/** Tiers not inferred from task SHAPE — the user asks by name, or the router escalates
 * into them from the rung below (Klaatu core/task_router.py _EDITOR_TITAN_PATTERNS).
 * NOTE 2026-07-29: titan auto-routing is now ENABLED — it IS in EDITOR_LADDER, so retry
 * escalation from heavy can reach it. This set still governs the auto-cascade copy and
 * tool-facing tier enums, because titan remains something you opt into rather than
 * something a prompt's wording lands you on. */
export const EXPLICIT_ONLY_TIERS = new Set(["titan"]);

// Context window sizes by tier — MUST match the brain's per-tier input budget
// (Klaatu api/context_engine.py _EDITOR_OVERFLOW_GUARDS), since the CLI sends
// `X-KlaatAI-Compaction: client` and the brain then trims to that guard. A
// larger client guess causes a double-trim (client compacts to its number,
// brain trims again to its lower number) → extra amnesia. Keep in lock-step.
//   Brain overflow guards (2026-07-23): nano 14K · fast 40K · code 200K ·
//   reason 125K (R1 160K − 32K output ceiling) · heavy 200K.
//   titan (2026-07-28): 220K guard (Kimi K3 256K window − 32K output cap); the
//   brain's soft context budget for titan is 180K, the guard is what trims.
export const TIER_CONTEXT_WINDOW: Record<string, number> = {
  nano:    14_000,
  fast:    40_000,
  code:   200_000,
  reason: 125_000,
  heavy:  200_000,
  titan:  220_000,
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
  heavy: 204, titan: 214, flash: 87, core: 75, beast: 204,
  smart: 228,
};

/**
 * Product-facing model name per tier.
 *
 * DERIVED from the generated table's `tiers[].label` — never re-typed. The hand-written
 * copy that used to live here had drifted (`beast` read "Klaatu Ultra"; canonical is
 * "Klaatu Beast"), so the same tier rendered under two names depending on the code path.
 * `smart` is the only entry with no row in the table: it is the absence of a pinned tier.
 */
export const KLAATU_MODEL_MAP: Record<string, string> = {
  ...Object.fromEntries(
    Object.entries(tierPricing.tiers as Record<string, { label?: string }>)
      .map(([tier, spec]) => [tier, spec.label ?? tier]),
  ),
  smart: "Klaatu Auto",
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
