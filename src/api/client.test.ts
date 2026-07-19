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
