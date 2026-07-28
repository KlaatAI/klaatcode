/**
 * Tier pricing, weights and caps — loaded from the GENERATED table.
 *
 * `src/data/tier-pricing.json` is a byte-identical mirror of the repo-root
 * `tier-pricing.json`, produced by `python3 scripts/sync_tier_pricing.py`. Never hand-edit
 * either the mirror or the numbers below.
 *
 * Why: until 2026-07-28 the CLI carried two hand-typed price tables (screens/tiers.ts and an
 * inline copy in api/client.ts) that disagreed with what the gateway actually bills on
 * nano/code/reason — the CLI under-reported spend by 38–50%, so "$0.06 this session" was
 * really $0.10. The gateway is contract-tested against the same file
 * (KlaatAI.Klaatu/tests/test_tier_pricing_contract.py), so these numbers cannot drift again.
 */

import table from "./data/tier-pricing.json";

type TierSpec = {
  input: number;
  output: number;
  weight: number;
  label?: string;
  surface?: string;
  explicit_only?: boolean;
};

type PlanCaps = { daily?: Record<string, number>; monthly?: Record<string, number> };

const TIERS = table.tiers as Record<string, TierSpec>;
const PLAN_CAPS = (table.plan_caps ?? {}) as Record<string, PlanCaps>;
const DEFAULT_TIER = (table.defaultTier as string) ?? "code";

/** [inputPerMTok, outputPerMTok] in USD — what the user is charged. */
export const TIER_COSTS: Record<string, [number, number]> = Object.fromEntries(
  Object.entries(TIERS).map(([tier, s]) => [tier, [s.input, s.output] as [number, number]]),
);

/** Weighted request units consumed per user turn (titan 10× a code turn). */
export const TIER_WEIGHTS: Record<string, number> = Object.fromEntries(
  Object.entries(TIERS).map(([tier, s]) => [tier, s.weight]),
);

/** Tiers with enforced per-day AND per-month ceilings — worth surfacing before they bite. */
export const PREMIUM_TIERS: readonly string[] = (table.premium_tiers as string[]) ?? [];

/** Human label ("Klaatu Titan") for a tier key. */
export function tierLabel(tier: string | null | undefined): string {
  return (tier && TIERS[tier]?.label) || tier || "";
}

export function tierWeight(tier: string | null | undefined): number {
  return (tier ? TIER_WEIGHTS[tier] : undefined) ?? 1;
}

/** True for tiers the router never picks on its own (titan). */
export function isExplicitOnly(tier: string | null | undefined): boolean {
  return !!(tier && TIERS[tier]?.explicit_only);
}

/** Dollar cost of one turn's tokens at a tier. Falls back to the default tier's rates. */
export function costUsd(promptTokens: number, completionTokens: number, tier?: string | null): number {
  const [inp, out] = TIER_COSTS[tier ?? ""] ?? TIER_COSTS[DEFAULT_TIER];
  return (promptTokens * inp + completionTokens * out) / 1_000_000;
}

/** Per-day / per-month cap for a tier on a plan, or undefined when uncapped. */
export function tierCap(
  plan: string | null | undefined,
  tier: string,
  scope: "daily" | "monthly",
): number | undefined {
  const caps = PLAN_CAPS[(plan || "").toLowerCase()];
  return caps?.[scope]?.[tier];
}

/** Premium caps for a plan, ordered most-expensive first (titan → heavy → reason). */
export function premiumCaps(
  plan: string | null | undefined,
): { tier: string; daily?: number; monthly?: number }[] {
  const order = [...PREMIUM_TIERS].sort((a, b) => tierWeight(b) - tierWeight(a));
  return order
    .map(tier => ({
      tier,
      daily: tierCap(plan, tier, "daily"),
      monthly: tierCap(plan, tier, "monthly"),
    }))
    .filter(row => row.daily !== undefined || row.monthly !== undefined);
}

/** First day of next month, UTC — when monthly ceilings reset. */
export function monthlyResetLabel(now = new Date()): string {
  const next = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() + 1, 1));
  return next.toLocaleDateString("en-US", { month: "short", day: "numeric", timeZone: "UTC" });
}
