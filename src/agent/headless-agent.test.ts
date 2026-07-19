import { expect, test } from "bun:test";
import { runHeadlessAgent } from "./headless-agent.js";
import type { KlaatAIClient, Message, StreamChunk } from "../api/client.js";

// Minimal fake client: scripts a sequence of stream responses, one per request.
function fakeClient(scripts: StreamChunk[][]): KlaatAIClient {
  let call = 0;
  return {
    async *chatStream(): AsyncGenerator<StreamChunk> {
      const script = scripts[Math.min(call, scripts.length - 1)]!;
      call += 1;
      for (const c of script) yield c;
    },
  } as unknown as KlaatAIClient;
}

const clock = () => { let t = 0; return () => (t += 1000); };
const user: Message[] = [{ role: "user", content: "hi" }];

test("single turn WITH server usage → authoritative, no estimate", async () => {
  const client = fakeClient([[
    { type: "token", text: "done" },
    { type: "metadata", usage: { prompt_tokens: 100, completion_tokens: 20, total_tokens: 120 },
      metadata: { tier: "code", model: "m1", reason: "", provider: "p", cascade_position: 0 } },
    { type: "done" },
  ]]);
  const r = await runHeadlessAgent(client, user, "/tmp", { tools: [], now: clock() });
  expect(r.stoppedBy).toBe("done");
  expect(r.promptTokens).toBe(100);
  expect(r.completionTokens).toBe(20);
  expect(r.usageEvents).toBe(1);
  expect(r.partialUsage).toBe(false);
  expect(r.estPromptTokens).toBe(0);
  expect(r.lastModel).toBe("m1");
});

test("single turn WITHOUT usage → char/4 estimate fills in", async () => {
  const client = fakeClient([[
    { type: "token", text: "some answer text" },
    { type: "done" },
  ]]);
  const r = await runHeadlessAgent(client, user, "/tmp", { tools: [], now: clock() });
  expect(r.usageEvents).toBe(0);
  expect(r.partialUsage).toBe(true);
  expect(r.promptTokens).toBe(0);
  expect(r.estCompletionTokens).toBeGreaterThan(0); // "some answer text" → >0
  expect(r.estPromptTokens).toBeGreaterThan(0);
  expect(r.estCostUsd).toBeGreaterThan(0);
});

test("error chunk stops immediately and records partialUsage", async () => {
  const client = fakeClient([[
    { type: "error", error: "quota reached" },
  ]]);
  const r = await runHeadlessAgent(client, user, "/tmp", { tools: [], now: clock() });
  expect(r.stoppedBy).toBe("error");
  expect(r.error).toBe("quota reached");
  expect(r.requests).toBe(1);
  expect(r.partialUsage).toBe(true);
});

test("respects maxTurns when the model keeps calling tools", async () => {
  // Every response asks for a (no-op) tool call → loop until maxTurns.
  const toolTurn: StreamChunk[] = [
    { type: "tool_call", tool_calls: [{ id: "t", type: "function", function: { name: "todo_read", arguments: "{}" } }] },
    { type: "done" },
  ];
  const client = fakeClient([toolTurn]);
  const r = await runHeadlessAgent(client, user, "/tmp", { tools: [], now: clock(), maxTurns: 3 });
  expect(r.stoppedBy).toBe("max_turns");
  expect(r.turns).toBe(3);
  expect(r.toolCalls).toBe(3);
});

// ─── 9.4 budget guards + doom-loop reaction ──────────────────────────────────

test("maxCostUsd stops the loop with stoppedBy max_cost", async () => {
  // Every turn reports ~$0.0105 of heavy usage and asks for another tool call.
  const costlyToolTurn: StreamChunk[] = [
    { type: "tool_call", tool_calls: [{ id: "t", type: "function", function: { name: "todo_read", arguments: "{}" } }] },
    { type: "metadata", usage: { prompt_tokens: 3_000, completion_tokens: 375, total_tokens: 3_375 },
      metadata: { tier: "heavy", model: "m", reason: "", provider: "p", cascade_position: 0 } },
    { type: "done" },
  ];
  const client = fakeClient([costlyToolTurn]);
  const r = await runHeadlessAgent(client, user, "/tmp", {
    tools: [], now: clock(), maxTurns: 50, maxCostUsd: 0.02,
  });
  expect(r.stoppedBy).toBe("max_cost");
  expect(r.error).toContain("cost cap");
  expect(r.costUsd).toBeGreaterThanOrEqual(0.02);
  expect(r.turns).toBeLessThan(5); // stopped early, nowhere near maxTurns
});

test("doom-loop signal refuses the round and stops after 3 refusals", async () => {
  const loopingTurn: StreamChunk[] = [
    { type: "tool_call", tool_calls: [{ id: "t", type: "function", function: { name: "grep", arguments: "{\"pattern\":\"x\"}" } }] },
    { type: "metadata", usage: { prompt_tokens: 10, completion_tokens: 5, total_tokens: 15 },
      metadata: { tier: "code", model: "m", reason: "", provider: "p", cascade_position: 0,
        loop_signal: { kind: "tool_repetition", count: 4, results_identical: true } } },
    { type: "done" },
  ];
  const client = fakeClient([loopingTurn]);
  const r = await runHeadlessAgent(client, user, "/tmp", { tools: [], now: clock(), maxTurns: 50 });
  expect(r.stoppedBy).toBe("loop");
  expect(r.error).toContain("doom loop");
  expect(r.toolCalls).toBe(0); // refused rounds never executed the tool
});

test("weak loop signal (results differ) does not refuse execution", async () => {
  const weakSignalTurn: StreamChunk[] = [
    { type: "tool_call", tool_calls: [{ id: "t", type: "function", function: { name: "todo_read", arguments: "{}" } }] },
    { type: "metadata", usage: { prompt_tokens: 10, completion_tokens: 5, total_tokens: 15 },
      metadata: { tier: "code", model: "m", reason: "", provider: "p", cascade_position: 0,
        loop_signal: { kind: "tool_repetition", count: 3, results_identical: false } } },
    { type: "done" },
  ];
  const client = fakeClient([weakSignalTurn]);
  const r = await runHeadlessAgent(client, user, "/tmp", { tools: [], now: clock(), maxTurns: 3 });
  expect(r.stoppedBy).toBe("max_turns"); // tools kept executing normally
  expect(r.toolCalls).toBe(3);
});
