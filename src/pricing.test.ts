import { describe, expect, test } from "bun:test";

import {
  PREMIUM_TIERS,
  TIER_COSTS,
  TIER_WEIGHTS,
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
} from "./pricing";

// These rates are what the GATEWAY bills (api/server.py _USER_COST_PER_MT) and are
// contract-tested on the server side against the same generated file. The CLI used to
// carry its own numbers (nano 0.10/0.20, code 0.50/1.50, reason 1.00/3.00) and showed
// users 38-50% less than they were charged — that regression is what this file guards.
describe("tier prices come from the generated table", () => {
  test("matches the gateway billing rates", () => {
    expect(TIER_COSTS.nano).toEqual([0.15, 0.50]);
    expect(TIER_COSTS.fast).toEqual([0.25, 0.75]);
    expect(TIER_COSTS.code).toEqual([0.80, 2.50]);
    expect(TIER_COSTS.reason).toEqual([2.00, 6.00]);
    expect(TIER_COSTS.heavy).toEqual([2.50, 8.00]);
    expect(TIER_COSTS.titan).toEqual([7.50, 37.50]);
  });

  test("no tier is free — a $0 row would silently under-report spend", () => {
    for (const [tier, [inp, out]] of Object.entries(TIER_COSTS)) {
      expect(inp, `${tier} input`).toBeGreaterThan(0);
      expect(out, `${tier} output`).toBeGreaterThan(0);
    }
  });

  test("costUsd uses the served tier and falls back to code", () => {
    // 100K in / 8K out on code: 100000*0.80/1e6 + 8000*2.50/1e6 = 0.08 + 0.02
    expect(costUsd(100_000, 8_000, "code")).toBeCloseTo(0.10, 6);
    // Same tokens on titan: 0.75 + 0.30
    expect(costUsd(100_000, 8_000, "titan")).toBeCloseTo(1.05, 6);
    expect(costUsd(100_000, 8_000, "nonsense")).toBeCloseTo(costUsd(100_000, 8_000, "code"), 6);
    expect(costUsd(100_000, 8_000, null)).toBeCloseTo(costUsd(100_000, 8_000, "code"), 6);
  });

  test("titan costs more than heavy at the same token count", () => {
    expect(costUsd(50_000, 5_000, "titan")).toBeGreaterThan(costUsd(50_000, 5_000, "heavy"));
  });
});

// Two MORE copies of the old table survived the 2026-07-28 sweep and were found on
// 2026-07-29: `RUN_TIER_COSTS` in main.tsx (the `--max-cost` guard) and `TIER_COST` in
// agent/headless-agent.ts (the `maxCostUsd` guard). Both carried nano 0.10/0.20,
// code 0.50/1.50, reason 1.00/3.00 — so a CI job told to stop at $1 would spend ~$1.60.
// This test fails if a seventh copy appears.
describe("no source file re-hardcodes tier rates", () => {
  const OLD_WRONG = [
    /nano:\s*\[\s*0\.10/,
    /code:\s*\[\s*0\.50/,
    /reason:\s*\[\s*1\.00/,
  ];

  test("the stale nano/code/reason literals appear nowhere in src/", async () => {
    const { Glob } = await import("bun");
    const offenders: string[] = [];
    for await (const file of new Glob("**/*.{ts,tsx}").scan({ cwd: import.meta.dir })) {
      if (file.endsWith(".test.ts") || file.endsWith(".test.tsx")) continue;
      if (file === "pricing.ts") continue; // generated values live here legitimately
      const text = await Bun.file(`${import.meta.dir}/${file}`).text();
      if (OLD_WRONG.some(re => re.test(text))) offenders.push(file);
    }
    expect(
      offenders,
      `these files hardcode the OLD wrong tier rates — import costUsd from pricing.ts instead`,
    ).toEqual([]);
  });

  test("only pricing.ts builds a tier→rate map", async () => {
    const { Glob } = await import("bun");
    const offenders: string[] = [];
    for await (const file of new Glob("**/*.{ts,tsx}").scan({ cwd: import.meta.dir })) {
      if (file.endsWith(".test.ts") || file.endsWith(".test.tsx")) continue;
      if (file === "pricing.ts") continue;
      const text = await Bun.file(`${import.meta.dir}/${file}`).text();
      // A literal object mapping a known tier name to a [number, number] pair.
      if (/\b(?:nano|code|reason|heavy|titan)\s*:\s*\[\s*\d+(?:\.\d+)?\s*,/.test(text)) {
        offenders.push(file);
      }
    }
    expect(
      offenders,
      `tier→rate tables must live only in pricing.ts (generated from tier-pricing.json)`,
    ).toEqual([]);
  });
});

describe("weights", () => {
  test("track the gateway pool weights", () => {
    expect(TIER_WEIGHTS.nano).toBe(0.25);
    expect(TIER_WEIGHTS.code).toBe(1);
    expect(TIER_WEIGHTS.reason).toBe(3);
    expect(TIER_WEIGHTS.heavy).toBe(4);
    expect(TIER_WEIGHTS.titan).toBe(15);
  });

  test("tierWeight defaults to 1 for unknown/empty", () => {
    expect(tierWeight("titan")).toBe(15);
    expect(tierWeight("mystery")).toBe(1);
    expect(tierWeight(null)).toBe(1);
    expect(tierWeight(undefined)).toBe(1);
  });
});

describe("premium caps", () => {
  test("pro caps match the plan matrix", () => {
    expect(tierCap("pro", "heavy", "daily")).toBe(10);
    expect(tierCap("pro", "heavy", "monthly")).toBe(20);
    expect(tierCap("pro", "titan", "daily")).toBe(2);
    expect(tierCap("pro", "titan", "monthly")).toBe(8);
  });

  test("uncapped combinations return undefined, not 0", () => {
    // 0 would render as "0/day" — i.e. blocked — which is a different statement.
    expect(tierCap("pro", "nano", "daily")).toBeUndefined();
    expect(tierCap("free", "titan", "monthly")).toBeUndefined();
    expect(tierCap("nonexistent-plan", "heavy", "daily")).toBeUndefined();
  });

  test("plan lookup is case-insensitive", () => {
    expect(tierCap("PRO", "titan", "monthly")).toBe(8);
  });

  test("premiumCaps lists the expensive tiers first", () => {
    const rows = premiumCaps("pro").map(r => r.tier);
    expect(rows[0]).toBe("titan");
    expect(rows).toContain("heavy");
    expect(rows).toContain("reason");
  });

  test("premiumCaps is empty for a plan with no premium access", () => {
    expect(premiumCaps("free")).toEqual([]);
  });

  test("premium tier set matches the server's enforced set", () => {
    expect([...PREMIUM_TIERS].sort()).toEqual(["heavy", "reason", "titan"]);
  });
});

describe("labels and explicit-only", () => {
  // Auto-routing for titan was enabled 2026-07-29, so explicit_only flipped to false.
  // The gateway side asserts this flag agrees with EDITOR_LADDER
  // (test_titan_auto_routing_flag_matches_the_ladder), so the badge we render always
  // matches what the router actually does.
  test("no tier is flagged explicit-only now that titan auto-routes", () => {
    expect(isExplicitOnly("titan")).toBe(false);
    expect(isExplicitOnly("heavy")).toBe(false);
    expect(isExplicitOnly(null)).toBe(false);
  });

  test("tierLabel falls back to the raw key", () => {
    expect(tierLabel("titan")).toBe("Klaatu Titan");
    expect(tierLabel("unknown-tier")).toBe("unknown-tier");
    expect(tierLabel(null)).toBe("");
  });
});

describe("monthlyResetLabel", () => {
  test("names the first of next month in UTC", () => {
    expect(monthlyResetLabel(new Date("2026-07-28T12:00:00Z"))).toBe("Aug 1");
  });

  test("rolls the year over in December", () => {
    expect(monthlyResetLabel(new Date("2026-12-15T12:00:00Z"))).toBe("Jan 1");
  });
});

// A5: the /cost "Per turn" line must match what the gateway actually charges. Printing a
// flat "titan 15×" understates a 50K-context turn by 4x — the opposite of the point of
// showing the cost before it's spent.
describe("A5 size-scaled unit cost", () => {
  test("a reference-size turn costs exactly the published weight", () => {
    expect(tierUnitCost("titan", 12_500)).toBeCloseTo(15, 3);
    expect(tierUnitCost("heavy", 12_500)).toBeCloseTo(4, 3);
  });

  test("small turns cost less and nothing exceeds the tier weight", () => {
    expect(tierUnitCost("titan", 5_000)).toBeCloseTo(6, 3);       // 0.4x floor
    expect(tierUnitCost("titan", 500_000)).toBeCloseTo(15, 3);    // capped at the weight
    expect(tierUnitCost("titan", 1)).toBeCloseTo(6, 3);
  });

  test("A6: a cheap model costs far less, an expensive one is capped", () => {
    expect(tierUnitCost("titan", 12_500, 0.0046)).toBeLessThan(4);   // V4 Pro direct
    expect(tierUnitCost("titan", 12_500, 0.0707)).toBeCloseTo(15, 3); // Opus, capped
  });

  test("the ceiling holds for every tier, size and cost", () => {
    for (const tier of ["reason", "heavy", "beast", "titan"]) {
      for (const tokens of [1, 12_500, 5_000_000]) {
        for (const cost of [undefined, 0.0001, 1, 1000]) {
          expect(tierUnitCost(tier, tokens, cost)).toBeLessThanOrEqual(TIER_WEIGHTS[tier]);
        }
      }
    }
  });

  test("cheap tiers stay flat", () => {
    for (const tier of ["nano", "fast", "code"]) {
      expect(unitsScaleWithSize(tier)).toBe(false);
      expect(tierUnitCost(tier, 500_000)).toBe(TIER_WEIGHTS[tier]);
    }
  });

  test("missing token count falls back to the flat weight", () => {
    expect(tierUnitCost("titan")).toBe(15);
    expect(tierUnitCost("titan", 0)).toBe(15);
  });

  test("the label is an upper bound for cost-billed tiers, flat for the rest", () => {
    expect(tierUnitCostLabel("titan")).toBe("≤15×");
    expect(tierUnitCostLabel("heavy")).toBe("≤4×");
    expect(tierUnitCostLabel("code")).toBe("1×");
    expect(tierUnitCostLabel("nano")).toBe("0.25×");
  });

  test("the CLI agrees with the gateway on which tiers scale", () => {
    // Mirrors api/quota.py _SIZE_AWARE_TIERS.
    expect(["reason", "heavy", "beast", "titan"].every(unitsScaleWithSize)).toBe(true);
  });
});
