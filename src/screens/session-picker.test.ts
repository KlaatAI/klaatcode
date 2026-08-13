import { describe, expect, test } from "bun:test";
import { filterSessions, runSessionPicker, type PickerStdin, type PickerStdout, type SessionChoice } from "./session-picker.js";

const SESSIONS: SessionChoice[] = [
  { id: "2026-07-28T19-48-12-4xdr", date: "2026-07-28 19:48", preview: "benchmark the cli" },
  { id: "2026-07-27T12-21-45-eh9x", date: "2026-07-27 12:21", preview: "fix the login flow" },
  { id: "2026-07-23T09-09-59-kkii", date: "2026-07-23 09:09", preview: "write release notes" },
];

/** Fake tty that records every raw-mode / pause call the picker makes. */
function fakeIo() {
  const listeners: Array<(k: string) => void> = [];
  const calls: string[] = [];
  const stdin: PickerStdin = {
    setRawMode: (raw) => calls.push(`setRawMode(${raw})`),
    resume:     () => calls.push("resume"),
    pause:      () => calls.push("pause"),
    setEncoding: () => {},
    on: (_e, cb) => { listeners.push(cb); },
    removeListener: (_e, cb) => {
      const i = listeners.indexOf(cb);
      if (i >= 0) listeners.splice(i, 1);
    },
  };
  const stdout: PickerStdout = { write: () => {}, rows: 24, columns: 80 };
  return {
    stdin, stdout, calls,
    get listenerCount() { return listeners.length; },
    press(key: string) { for (const l of [...listeners]) l(key); },
  };
}

describe("runSessionPicker", () => {
  test("Enter resolves the focused session id", async () => {
    const io = fakeIo();
    const p = runSessionPicker({ ...io, sessions: SESSIONS });
    await Promise.resolve();
    io.press("\x1b[B"); // down → second entry
    io.press("\r");
    expect(await p).toBe("2026-07-27T12-21-45-eh9x");
  });

  test("Esc and Ctrl+C start fresh", async () => {
    for (const key of ["\x1b", "\x03"]) {
      const io = fakeIo();
      const p = runSessionPicker({ ...io, sessions: SESSIONS });
      await Promise.resolve();
      io.press(key);
      expect(await p).toBeNull();
    }
  });

  test("typing filters the list", async () => {
    const io = fakeIo();
    const p = runSessionPicker({ ...io, sessions: SESSIONS });
    await Promise.resolve();
    for (const c of "login") io.press(c);
    io.press("\r");
    expect(await p).toBe("2026-07-27T12-21-45-eh9x");
  });

  // Regression: the listener used to stay attached for the life of the process.
  // It then ran alongside the TUI's InputParser, and the first Enter inside the
  // TUI re-triggered cleanup() → setRawMode(false) + stdin.pause(), silently
  // killing all input. The session looked frozen and needed a force-close.
  test("detaches its stdin listener once resolved", async () => {
    const io = fakeIo();
    const p = runSessionPicker({ ...io, sessions: SESSIONS });
    await Promise.resolve();
    expect(io.listenerCount).toBe(1);
    io.press("\r");
    await p;
    expect(io.listenerCount).toBe(0);
  });

  test("post-resolve keystrokes can never re-disable raw mode or pause stdin", async () => {
    const io = fakeIo();
    const p = runSessionPicker({ ...io, sessions: SESSIONS });
    await Promise.resolve();
    io.press("\r");
    await p;

    const after = io.calls.length;
    // Replay the keys a TUI session would produce, Enter included.
    for (const key of ["\r", "\x1b", "\x03", "a", "\x1b[A"]) io.press(key);
    expect(io.calls.length).toBe(after);
    expect(io.calls.filter(c => c === "pause")).toHaveLength(1);
    expect(io.calls.filter(c => c === "setRawMode(false)")).toHaveLength(1);
  });

  test("no saved sessions resolves null without touching raw mode", async () => {
    const io = fakeIo();
    expect(await runSessionPicker({ ...io, sessions: [] })).toBeNull();
    expect(io.calls).toHaveLength(0);
    expect(io.listenerCount).toBe(0);
  });
});

describe("filterSessions", () => {
  test("empty query returns everything", () => {
    expect(filterSessions(SESSIONS, "")).toHaveLength(3);
  });

  test("matches preview, id and date, case-insensitively", () => {
    expect(filterSessions(SESSIONS, "LOGIN").map(s => s.id)).toEqual(["2026-07-27T12-21-45-eh9x"]);
    expect(filterSessions(SESSIONS, "kkii").map(s => s.id)).toEqual(["2026-07-23T09-09-59-kkii"]);
    expect(filterSessions(SESSIONS, "2026-07-28")).toHaveLength(1);
  });

  test("no match returns empty", () => {
    expect(filterSessions(SESSIONS, "zzz")).toHaveLength(0);
  });
});
