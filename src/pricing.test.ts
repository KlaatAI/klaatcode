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
  tierWeight,
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
  test("titan is flagged explicit-only, heavy is not", () => {
    expect(isExplicitOnly("titan")).toBe(true);
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
