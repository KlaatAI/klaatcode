import { describe, expect, test } from "bun:test";
import { PhaseTracker } from "./phase-budget.js";

describe("PhaseTracker", () => {
  test("starts in explore and attributes usage there", () => {
    const t = new PhaseTracker();
    t.addUsage(5_000);
    expect(t.phase).toBe("explore");
    expect(t.tokens.explore).toBe(5_000);
    expect(t.tokens.implement).toBe(0);
  });

  test("phase priority: mutation beats command beats read-only", () => {
    const t = new PhaseTracker();
    t.noteTools(["read_file", "run_command", "edit_file"]);
    expect(t.phase).toBe("implement");
    expect(t.hasArtifact).toBe(true);
    t.noteTools(["run_command", "grep"]);
    expect(t.phase).toBe("verify");
    t.noteTools(["grep", "read_file"]);
    expect(t.phase).toBe("explore");
    // empty round: phase unchanged
    t.noteTools([]);
    expect(t.phase).toBe("explore");
  });

  // ── Pause semantics ────────────────────────────────────────────────────────
  // Explore overage HARD-PAUSES only with evidence of being stuck: a doom-loop
  // (identical call/results repeated) OR a runaway 2× past budget. A plain
  // overage is a soft warn — token count alone is a poor "stuck" proxy (legit
  // big-data analysis reads a lot without repeating).

  test("explore overage WITHOUT loop → warn, no pause", () => {
    const t = new PhaseTracker({ budgets: { explore: 10_000 } });
    expect(t.addUsage(9_000)).toBeNull();
    const ev = t.addUsage(2_000); // 11K > 10K, but no loop, < 2× → warn
    expect(ev?.kind).toBe("warn");
    expect(t.paused).toBe(false);
  });

  test("explore overage WITH doom-loop → pause", () => {
    const t = new PhaseTracker({ budgets: { explore: 10_000 } });
    expect(t.addUsage(9_000, 0, { loopSuspected: true })).toBeNull();
    const ev = t.addUsage(2_000, 0, { loopSuspected: true });
    expect(ev?.kind).toBe("pause");
    expect(ev?.phase).toBe("explore");
    expect(t.paused).toBe(true);
    // one event per task — no repeat spam
    expect(t.addUsage(50_000, 0, { loopSuspected: true })).toBeNull();
  });

  test("runaway 2× budget pauses even without a loop", () => {
    const t = new PhaseTracker({ budgets: { explore: 10_000 } });
    const ev = t.addUsage(21_000); // > 2×10K, no loop → still pause (backstop)
    expect(ev?.kind).toBe("pause");
    expect(t.paused).toBe(true);
  });

  test("MCP-prefixed mutating tool counts as implement + artifact", () => {
    const t = new PhaseTracker();
    t.noteTools(["mcp__filesystem__write_file"]);
    expect(t.phase).toBe("implement");
    expect(t.hasArtifact).toBe(true);
    // MCP shell → verify
    const v = new PhaseTracker();
    v.noteTools(["mcp__shell__run_command"]);
    expect(v.phase).toBe("verify");
  });

  test("explore over budget WITH artifact → soft warn, no pause", () => {
    const t = new PhaseTracker({ budgets: { explore: 10_000 } });
    t.noteTools(["edit_file"]);   // produced an artifact…
    t.noteTools(["grep"]);        // …then back to exploring
    const ev = t.addUsage(50_000, 0, { loopSuspected: true }); // even looping
    expect(ev?.kind).toBe("warn");   // artifact exists → never a stuck pause
    expect(t.paused).toBe(false);
  });

  test("implement over budget → warn only", () => {
    const t = new PhaseTracker({ budgets: { implement: 10_000 } });
    t.noteTools(["write_file"]);
    const ev = t.addUsage(11_000);
    expect(ev?.kind).toBe("warn");
    expect(ev?.phase).toBe("implement");
    expect(t.paused).toBe(false);
  });

  test("reset clears tokens, phase, artifact, pause, and re-arms the event", () => {
    const t = new PhaseTracker({ budgets: { explore: 1_000 } });
    expect(t.addUsage(2_000, 0, { loopSuspected: true })?.kind).toBe("pause");
    t.reset();
    expect(t.paused).toBe(false);
    expect(t.tokens.explore).toBe(0);
    expect(t.phase).toBe("explore");
    // fires again on the new task
    expect(t.addUsage(2_000, 0, { loopSuspected: true })?.kind).toBe("pause");
  });

  test("resumeAfterContinue clears pause and enlarges explore budget", () => {
    const t = new PhaseTracker(); // default explore budget 60_000
    // burn past the default budget while looping → pause
    expect(t.addUsage(61_000, 0, { loopSuspected: true })?.kind).toBe("pause");
    expect(t.paused).toBe(true);
    t.resumeAfterContinue();
    expect(t.paused).toBe(false);
    expect(t.tokens.explore).toBe(0);
    expect(t.phase).toBe("explore");
    // budget is now larger (default × 1.6 = 96_000) — the same 61K no longer pauses
    expect(t.budgets.explore).toBe(96_000);
    expect(t.addUsage(61_000, 0, { loopSuspected: true })).toBeNull();
    // crossing the enlarged budget while looping still pauses (and only once)
    expect(t.addUsage(40_000, 0, { loopSuspected: true })?.kind).toBe("pause");
  });

  test("scaleForWindow raises explore budget on a big-window tier", () => {
    const t = new PhaseTracker(); // default explore 60_000
    t.scaleForWindow(118_000);    // reason tier → 118K × 1.5 = 177_000
    expect(t.budgets.explore).toBe(177_000);
    // 75K of legit exploration no longer trips anything (the false-positive case)
    expect(t.addUsage(75_000)).toBeNull();
    // over the scaled budget but not looping → warn, not pause
    expect(t.addUsage(110_000)?.kind).toBe("warn");
    expect(t.paused).toBe(false);
  });

  test("scaleForWindow keeps the 60K floor for small windows", () => {
    const t = new PhaseTracker();
    t.scaleForWindow(28_000);     // fast tier → 28K×1.5=42K < 60K floor
    expect(t.budgets.explore).toBe(60_000);
  });

  test("a substantive answer downgrades even a looping explore overage to warn", () => {
    const t = new PhaseTracker({ budgets: { explore: 10_000 } });
    // model produced a real answer (≥600 output tokens) while exploring
    const ev = t.addUsage(12_000, 700, { loopSuspected: true });
    expect(ev?.kind).toBe("warn");   // answered → not "stuck"
    expect(t.paused).toBe(false);
  });

  test("silent looping read (tiny output) pauses", () => {
    const t = new PhaseTracker({ budgets: { explore: 10_000 } });
    const ev = t.addUsage(12_000, 50, { loopSuspected: true });
    expect(ev?.kind).toBe("pause");
    expect(t.paused).toBe(true);
  });

  test("resume budget scales off the window-scaled base", () => {
    const t = new PhaseTracker();
    t.scaleForWindow(118_000);        // base → 177_000
    expect(t.addUsage(180_000, 0, { loopSuspected: true })?.kind).toBe("pause");
    t.resumeAfterContinue();
    expect(t.budgets.explore).toBe(Math.round(177_000 * 1.6));
  });

  test("disabled tracker never raises", () => {
    const t = new PhaseTracker({ enabled: false, budgets: { explore: 100 } });
    expect(t.addUsage(1_000_000, 0, { loopSuspected: true })).toBeNull();
    expect(t.paused).toBe(false);
  });

  test("exactly at budget does not trigger; one token over warns (no loop)", () => {
    const t = new PhaseTracker({ budgets: { explore: 10_000 } });
    expect(t.addUsage(10_000)).toBeNull();
    expect(t.addUsage(1)?.kind).toBe("warn");
  });
});
