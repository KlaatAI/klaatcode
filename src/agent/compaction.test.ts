import { expect, test } from "bun:test";
import { charBudgetForWindow, compactMessagesForApi } from "./compaction.js";
import type { Message } from "../api/client.js";

test("charBudgetForWindow: no window → full 240K default", () => {
  expect(charBudgetForWindow()).toBe(240_000);
  expect(charBudgetForWindow(0)).toBe(240_000);
});

test("charBudgetForWindow: large windows stay capped at 240K", () => {
  expect(charBudgetForWindow(131_000)).toBe(240_000);
  expect(charBudgetForWindow(200_000)).toBe(240_000);
});

test("charBudgetForWindow: small tier windows shrink the budget", () => {
  // nano 16K: (16000-8000) * 4 * 0.85 = 27_200
  expect(charBudgetForWindow(16_000)).toBe(27_200);
  // fast 32K: (32000-8000) * 4 * 0.85 = 81_600
  expect(charBudgetForWindow(32_000)).toBe(81_600);
  // pathological tiny window still leaves a floor
  expect(charBudgetForWindow(1_000)).toBe(13_600);
});

function mkHistory(turns: number, toolChars: number): Message[] {
  const msgs: Message[] = [{ role: "system", content: "sys" }];
  for (let i = 0; i < turns; i++) {
    msgs.push({ role: "user", content: `q${i}` });
    msgs.push({
      role: "assistant", content: `a${i}`,
      tool_calls: [{ id: `c${i}`, type: "function", function: { name: "grep", arguments: "{}" } }],
    } as Message);
    msgs.push({ role: "tool", content: "x".repeat(toolChars), tool_call_id: `c${i}` } as Message);
  }
  return msgs;
}

test("small window compacts harder than default", () => {
  const msgs = mkHistory(20, 3_000);
  const chars = (r: Message[]) =>
    r.reduce((s, m) => s + (typeof m.content === "string" ? m.content.length : 0), 0);
  const wide = compactMessagesForApi(msgs);
  const nano = compactMessagesForApi(msgs, 16_000);
  expect(chars(nano)).toBeLessThan(chars(wide));
  expect(chars(nano)).toBeLessThanOrEqual(charBudgetForWindow(16_000));
});

test("system seed survives tight-budget compaction", () => {
  const msgs = mkHistory(30, 5_000);
  const out = compactMessagesForApi(msgs, 16_000);
  expect(out[0]!.role).toBe("system");
  expect(out[0]!.content).toBe("sys");
});

// ─── 9.3 attention ordering ──────────────────────────────────────────────────

import { orderForAttention } from "./compaction.js";

function turn(i: number, opts: { userLen?: number; toolContent?: string } = {}): Message[] {
  return [
    { role: "user", content: opts.userLen ? "u".repeat(opts.userLen) : `q${i}` },
    {
      role: "assistant", content: `a${i}`,
      tool_calls: [{ id: `c${i}`, type: "function", function: { name: "grep", arguments: "{}" } }],
    } as Message,
    { role: "tool", content: opts.toolContent ?? `t${i}`, tool_call_id: `c${i}` } as Message,
  ];
}

test("orderForAttention: fewer than 6 groups left untouched", () => {
  const zone = [...turn(0), ...turn(1), ...turn(2)];
  expect(orderForAttention(zone)).toEqual(zone);
});

test("orderForAttention: tool results stay adjacent to their tool_calls", () => {
  const zone = [
    ...turn(0), ...turn(1, { toolContent: "y".repeat(2_000) }), ...turn(2),
    ...turn(3, { userLen: 500 }), ...turn(4), ...turn(5), ...turn(6),
  ];
  const out = orderForAttention(zone);
  expect(out.length).toBe(zone.length);
  for (let i = 0; i < out.length; i++) {
    const m = out[i]!;
    if (m.role === "assistant" && m.tool_calls?.length) {
      const next = out[i + 1]!;
      expect(next.role).toBe("tool");
      expect(next.tool_call_id).toBe(m.tool_calls[0]!.id);
    }
  }
});

test("orderForAttention: high-relevance groups move to the edges", () => {
  const zone = [
    ...turn(0), ...turn(1), ...turn(2),
    ...turn(3, { toolContent: "z".repeat(3_000) }), // highest score
    ...turn(4), ...turn(5),
  ];
  const out = orderForAttention(zone);
  // The big-read group should now start the zone (edge slot 0).
  expect(out[0]!.content).toBe("q3");
});

test("orderForAttention: compaction stub pinned to front", () => {
  const stub: Message = { role: "assistant", content: "[Context compacted — summary]" };
  const zone = [stub, ...turn(0), ...turn(1, { toolContent: "z".repeat(3_000) }),
    ...turn(2), ...turn(3), ...turn(4), ...turn(5)];
  const out = orderForAttention(zone);
  expect(out[0]!.content).toBe("[Context compacted — summary]");
});

test("compactMessagesForApi: attentionOrder=false preserves chronology", () => {
  const msgs = mkHistory(12, 2_000);
  const out = compactMessagesForApi(msgs, undefined, { attentionOrder: false });
  const users = out.filter(m => m.role === "user").map(m => m.content);
  expect(users).toEqual([...users].sort((a, b) =>
    Number(String(a).slice(1)) - Number(String(b).slice(1))));
});

test("compactMessagesForApi: reorder keeps protected recent turns at the tail", () => {
  const msgs = mkHistory(20, 2_000);
  const out = compactMessagesForApi(msgs);
  // Last user message must still be the chronologically-last one.
  const lastUser = [...out].reverse().find(m => m.role === "user");
  expect(lastUser!.content).toBe("q19");
  // Message count unchanged by reordering.
  expect(out.length).toBe(msgs.length);
});
