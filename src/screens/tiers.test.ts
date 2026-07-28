import { expect, test } from "bun:test";
import {
  TIER_COSTS, TIER_CONTEXT_WINDOW, VALID_TIERS, EXPLICIT_ONLY_TIERS,
  TIER_COLOR_MAP, KLAATU_MODEL_MAP,
} from "./tiers.js";
import { KlaatAIClient } from "../api/client.js";
import { TOOL_DEFINITIONS } from "../tools/index.js";
import { dialectForTier } from "../tools/dialects.js";

const EDITOR_TIERS = ["nano", "fast", "code", "reason", "heavy", "titan"];

test("every editor tier is accepted by /tier and fully described", () => {
  for (const t of EDITOR_TIERS) {
    expect(VALID_TIERS.has(t)).toBe(true);
    expect(TIER_COSTS[t]).toBeDefined();
    expect(TIER_CONTEXT_WINDOW[t]).toBeGreaterThan(0);
    expect(TIER_COLOR_MAP[t]).toBeDefined();
    expect(KLAATU_MODEL_MAP[t]).toBeDefined();
  }
});

// Prices now come from the generated tier-pricing table (src/data/tier-pricing.json,
// mirrored from the repo root and contract-tested against the gateway's
// _USER_COST_PER_MT). The context window still mirrors
// api/context_engine.py _EDITOR_OVERFLOW_GUARDS["titan"] — a client guess above the
// brain's guard causes a double-trim, so keep that in lock-step.
test("titan carries the server's price and overflow guard", () => {
  expect(TIER_COSTS["titan"]).toEqual([7.50, 37.50]);
  expect(TIER_CONTEXT_WINDOW["titan"]).toBe(220_000);
});

test("titan cost receipt uses titan pricing, not the code-tier fallback", () => {
  const cost = KlaatAIClient.formatCost(
    { tier: "titan", model: "kimi-k3", reason: "", provider: "modal", cascade_position: 0 },
    { prompt_tokens: 100_000, completion_tokens: 10_000 },
  );
  // 100K × $7.50/MTok + 10K × $37.50/MTok = $0.75 + $0.375
  expect(cost).toBe("$1.1250");
});

test("titan is explicit-request only — never offered as a delegate_task tier", () => {
  expect(EXPLICIT_ONLY_TIERS.has("titan")).toBe(true);
  const delegate = TOOL_DEFINITIONS.find(t => t.function.name === "delegate_task");
  expect(delegate).toBeDefined();
  const tierEnum = (delegate!.function.parameters as any).properties.tier.enum as string[];
  expect(tierEnum).not.toContain("titan");
  expect(tierEnum).toContain("heavy");
});

test("titan gets the full tool dialect", () => {
  expect(dialectForTier("titan")).toBe("full");
});
