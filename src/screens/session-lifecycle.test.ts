import { describe, expect, test } from "bun:test";
import { createSessionLifecycle, type SessionLifecycleEvent } from "./session-lifecycle";

describe("createSessionLifecycle", () => {
  test("session_start fires exactly once on start()", () => {
    const events: SessionLifecycleEvent[] = [];
    const life = createSessionLifecycle((e) => events.push(e));

    life.start();
    life.start();
    life.start();

    expect(events).toEqual(["session_start"]);
    expect(life.started).toBe(true);
    expect(life.ended).toBe(false);
  });

  test("session_end fires exactly once on end() — covers /exit, Ctrl+D, Ctrl+C all calling quit()", () => {
    const events: SessionLifecycleEvent[] = [];
    const life = createSessionLifecycle((e) => events.push(e));

    life.start();
    // Simulate multiple quit triggers (Ctrl+C then /exit, etc.)
    life.end();
    life.end();
    life.end();

    expect(events).toEqual(["session_start", "session_end"]);
    expect(life.ended).toBe(true);
  });

  test("session_end without a prior start still fires once", () => {
    const events: SessionLifecycleEvent[] = [];
    const life = createSessionLifecycle((e) => events.push(e));

    life.end();
    life.end();

    expect(events).toEqual(["session_end"]);
  });

  test("normal boot → quit sequence", () => {
    const events: SessionLifecycleEvent[] = [];
    const life = createSessionLifecycle((e) => events.push(e));

    // boot
    life.start();
    // graceful quit
    life.end();

    expect(events).toEqual(["session_start", "session_end"]);
  });
});
