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

  test("explore over budget with NO artifact → pause", () => {
    const t = new PhaseTracker({ budgets: { explore: 10_000 } });
    expect(t.addUsage(9_000)).toBeNull();
    const ev = t.addUsage(2_000);
    expect(ev?.kind).toBe("pause");
    expect(ev?.phase).toBe("explore");
    expect(t.paused).toBe(true);
    // one event per task — no repeat spam
    expect(t.addUsage(50_000)).toBeNull();
  });

  test("explore over budget WITH artifact → soft warn, no pause", () => {
    const t = new PhaseTracker({ budgets: { explore: 10_000 } });
    t.noteTools(["edit_file"]);   // produced an artifact…
    t.noteTools(["grep"]);        // …then back to exploring
    const ev = t.addUsage(12_000);
    expect(ev?.kind).toBe("warn");
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
    expect(t.addUsage(2_000)?.kind).toBe("pause");
    t.reset();
    expect(t.paused).toBe(false);
    expect(t.tokens.explore).toBe(0);
    expect(t.phase).toBe("explore");
    expect(t.addUsage(2_000)?.kind).toBe("pause"); // fires again on the new task
  });

  test("disabled tracker never raises", () => {
    const t = new PhaseTracker({ enabled: false, budgets: { explore: 100 } });
    expect(t.addUsage(1_000_000)).toBeNull();
    expect(t.paused).toBe(false);
  });

  test("exactly at budget does not trigger; one token over does", () => {
    const t = new PhaseTracker({ budgets: { explore: 10_000 } });
    expect(t.addUsage(10_000)).toBeNull();
    expect(t.addUsage(1)?.kind).toBe("pause");
  });
});
