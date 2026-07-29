import { expect, test } from "bun:test";
import { KlaatAIClient } from "./client.js";

test("parseQuotaHeaders reads weighted units + legacy + plan/tier", () => {
  const h = new Headers({
    "X-KlaatAI-Units-Used": "42.5",
    "X-KlaatAI-Units-Limit": "150",
    "X-KlaatAI-Quota-Used": "30",
    "X-KlaatAI-Quota-Limit": "75",
    "X-KlaatAI-Quota-Plan": "pro",
    "X-KlaatAI-Tier": "code",
  });
  const q = KlaatAIClient.parseQuotaHeaders(h);
  expect(q).not.toBeNull();
  expect(q!.unitsUsed).toBe(42.5);
  expect(q!.unitsLimit).toBe(150);
  expect(q!.requestsUsed).toBe(30);
  expect(q!.plan).toBe("pro");
  expect(q!.tier).toBe("code");
});

test("parseQuotaHeaders returns null when no headers present", () => {
  expect(KlaatAIClient.parseQuotaHeaders(new Headers())).toBeNull();
});

test("parseQuotaHeaders tolerates a partial subset", () => {
  const q = KlaatAIClient.parseQuotaHeaders(new Headers({ "X-KlaatAI-Units-Used": "5" }));
  expect(q).not.toBeNull();
  expect(q!.unitsUsed).toBe(5);
  expect(q!.unitsLimit).toBeUndefined();
  expect(q!.plan).toBeUndefined();
});

test("parseQuotaHeaders ignores non-numeric unit values", () => {
  const q = KlaatAIClient.parseQuotaHeaders(new Headers({ "X-KlaatAI-Units-Used": "n/a", "X-KlaatAI-Quota-Plan": "free" }));
  expect(q).not.toBeNull();
  expect(q!.unitsUsed).toBeUndefined();
  expect(q!.plan).toBe("free");
});

// ─── 9.4 retry contract + loop signal ────────────────────────────────────────

test("retryDelayMs: X-KlaatAI-Retry no → never retry", () => {
  expect(KlaatAIClient.retryDelayMs(new Headers({ "X-KlaatAI-Retry": "no" }), 502)).toBeNull();
  // "no" wins even on a 429 that carries Retry-After
  expect(KlaatAIClient.retryDelayMs(
    new Headers({ "X-KlaatAI-Retry": "no", "Retry-After": "5" }), 429)).toBeNull();
});

test("retryDelayMs: after-<s> schedules one retry", () => {
  expect(KlaatAIClient.retryDelayMs(new Headers({ "X-KlaatAI-Retry": "after-3" }), 503)).toBe(3000);
  expect(KlaatAIClient.retryDelayMs(new Headers({ "X-KlaatAI-Retry": "after-0.5" }), 503)).toBe(500);
});

test("retryDelayMs: bare 429 falls back to Retry-After", () => {
  expect(KlaatAIClient.retryDelayMs(new Headers({ "Retry-After": "7" }), 429)).toBe(7000);
  // non-429 without a hint → no retry
  expect(KlaatAIClient.retryDelayMs(new Headers({ "Retry-After": "7" }), 500)).toBeNull();
  // absent/garbage headers → no retry
  expect(KlaatAIClient.retryDelayMs(new Headers(), 429)).toBeNull();
  expect(KlaatAIClient.retryDelayMs(new Headers({ "X-KlaatAI-Retry": "banana" }), 429)).toBeNull();
});

test("parseQuotaHeaders surfaces X-KlaatAI-Loop-Signal", () => {
  const q = KlaatAIClient.parseQuotaHeaders(
    new Headers({ "X-KlaatAI-Loop-Signal": "tool_repetition:3" }));
  expect(q).not.toBeNull();
  expect(q!.loopSignal).toBe("tool_repetition:3");
});

// ─── mid-stream connection drop ──────────────────────────────────────────────
// A socket that dies partway through the SSE body used to throw Bun's raw
// "The socket connection was closed unexpectedly" out of the generator, which
// killed the turn and discarded everything the model had already sent.
//
// acp/agent.test.ts installs a process-global mock.module on this file. Its
// chatStream stub is scoped per-test; when no stub is active the mock delegates
// to super.chatStream (see acp/agent.test.ts). These tests still mock fetch
// directly because they exercise the real stream parser.

/** Response whose SSE body emits `frames` then fails the reader. */
function droppedStream(frames: string[]): Response {
  // One frame per pull, then fail — erroring inside start() would discard the
  // already-queued frames and never exercise the salvage path.
  const enc = new TextEncoder();
  let i = 0;
  const body = new ReadableStream<Uint8Array>({
    pull(controller) {
      if (i < frames.length) { controller.enqueue(enc.encode(frames[i]!)); i++; return; }
      controller.error(new Error("The socket connection was closed unexpectedly"));
    },
  });
  return new Response(body, { status: 200, headers: { "Content-Type": "text/event-stream" } });
}

async function collect(client: KlaatAIClient) {
  const out: Array<{ type: string; text?: string; error?: string }> = [];
  for await (const c of client.chatStream([{ role: "user", content: "hi" }])) {
    out.push({ type: c.type, text: c.text, error: c.error });
  }
  return out;
}

test("chatStream: socket drop after tokens keeps the partial answer and ends cleanly", async () => {
  const realFetch = globalThis.fetch;
  globalThis.fetch = (async () => droppedStream([
    'data: {"choices":[{"delta":{"content":"Hello"}}]}\n',
    'data: {"choices":[{"delta":{"content":" world"}}]}\n',
  ])) as typeof fetch;
  try {
    const chunks = await collect(new KlaatAIClient({ apiKey: "test" }));
    expect(chunks.filter(c => c.type === "token").map(c => c.text)).toEqual(["Hello", " world"]);
    expect(chunks.at(-1)!.type).toBe("done");
    expect(chunks.some(c => c.type === "error")).toBe(false);
  } finally {
    globalThis.fetch = realFetch;
  }
});

test("chatStream: socket drop before any output reports an actionable error", async () => {
  const realFetch = globalThis.fetch;
  globalThis.fetch = (async () => droppedStream([])) as typeof fetch;
  try {
    const chunks = await collect(new KlaatAIClient({ apiKey: "test" }));
    expect(chunks).toHaveLength(1);
    expect(chunks[0]!.type).toBe("error");
    expect(chunks[0]!.error).toContain("Connection to the model was lost");
  } finally {
    globalThis.fetch = realFetch;
  }
});

test("chatStream: unreachable host yields an error chunk instead of throwing", async () => {
  const realFetch = globalThis.fetch;
  globalThis.fetch = (async () => { throw new Error("getaddrinfo ENOTFOUND api.klaatai.com"); }) as typeof fetch;
  try {
    const chunks = await collect(new KlaatAIClient({ apiKey: "test" }));
    expect(chunks).toHaveLength(1);
    expect(chunks[0]!.type).toBe("error");
    expect(chunks[0]!.error).toContain("Could not reach the model");
  } finally {
    globalThis.fetch = realFetch;
  }
});
