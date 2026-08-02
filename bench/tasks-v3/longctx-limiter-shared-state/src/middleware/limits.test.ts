import { test, expect } from "bun:test";
import { buildApp } from "../app";
import { FakeClock } from "../util/clock";
import type { KRequest } from "../http/types";

function reqAs(token: string, path = "/reports"): KRequest {
  return {
    method: "GET",
    path,
    headers: { Authorization: `Bearer ${token}` },
  };
}

test("a user within budget gets 200s with decreasing remaining header", async () => {
  const clock = new FakeClock();
  const app = buildApp({ clock, rateLimitPerWindow: 3, rateLimitWindowMs: 60_000 });

  const r1 = await app.handle(reqAs("tok-alice"));
  const r2 = await app.handle(reqAs("tok-alice"));
  const r3 = await app.handle(reqAs("tok-alice"));

  expect(r1.status).toBe(200);
  expect(r1.headers["x-ratelimit-remaining"]).toBe("2");
  expect(r2.headers["x-ratelimit-remaining"]).toBe("1");
  expect(r3.headers["x-ratelimit-remaining"]).toBe("0");
});

test("a user over budget is rejected with 429 and retry-after", async () => {
  const clock = new FakeClock();
  const app = buildApp({ clock, rateLimitPerWindow: 2, rateLimitWindowMs: 60_000 });

  await app.handle(reqAs("tok-alice"));
  await app.handle(reqAs("tok-alice"));
  const rejected = await app.handle(reqAs("tok-alice"));

  expect(rejected.status).toBe(429);
  expect(rejected.headers["retry-after"]).toBe("60");
  expect(rejected.body).toEqual({ error: "rate limit exceeded" });
});

test("one user exhausting their budget must not throttle another user", async () => {
  const clock = new FakeClock();
  const app = buildApp({ clock, rateLimitPerWindow: 2, rateLimitWindowMs: 60_000 });

  // Alice burns through her entire budget and gets rejected.
  await app.handle(reqAs("tok-alice"));
  await app.handle(reqAs("tok-alice"));
  const aliceRejected = await app.handle(reqAs("tok-alice"));
  expect(aliceRejected.status).toBe(429);

  // Bob has made zero requests: his independent budget must be untouched.
  const bobFirst = await app.handle(reqAs("tok-bob"));
  expect(bobFirst.status).toBe(200);
  expect(bobFirst.headers["x-ratelimit-remaining"]).toBe("1");
});

test("interleaved users each get their full independent quota", async () => {
  const clock = new FakeClock();
  const app = buildApp({ clock, rateLimitPerWindow: 2, rateLimitWindowMs: 60_000 });

  const statuses: number[] = [];
  for (const token of ["tok-alice", "tok-bob", "tok-alice", "tok-bob"]) {
    const res = await app.handle(reqAs(token));
    statuses.push(res.status);
  }

  // 2 requests each against a per-user limit of 2: everything passes.
  expect(statuses).toEqual([200, 200, 200, 200]);
});

test("a user's budget resets after their window lapses", async () => {
  const clock = new FakeClock();
  const app = buildApp({ clock, rateLimitPerWindow: 2, rateLimitWindowMs: 60_000 });

  await app.handle(reqAs("tok-carol"));
  await app.handle(reqAs("tok-carol"));
  expect((await app.handle(reqAs("tok-carol"))).status).toBe(429);

  clock.advance(60_000);
  const afterReset = await app.handle(reqAs("tok-carol"));
  expect(afterReset.status).toBe(200);
  expect(afterReset.headers["x-ratelimit-remaining"]).toBe("1");
});

test("requests actually reach per-user handlers (distinct bodies per user)", async () => {
  const clock = new FakeClock();
  const app = buildApp({ clock, rateLimitPerWindow: 5, rateLimitWindowMs: 60_000 });

  const alice = await app.handle(reqAs("tok-alice"));
  const bob = await app.handle(reqAs("tok-bob"));

  expect((alice.body as { owner: string }).owner).toBe("alice");
  expect((bob.body as { owner: string }).owner).toBe("bob");
});

test("unauthenticated requests are rejected before consuming any quota", async () => {
  const clock = new FakeClock();
  const app = buildApp({ clock, rateLimitPerWindow: 1, rateLimitWindowMs: 60_000 });

  const anon = await app.handle({ method: "GET", path: "/reports" });
  expect(anon.status).toBe(401);

  // The 401s above must not have burned Dave's budget.
  const dave = await app.handle(reqAs("tok-dave"));
  expect(dave.status).toBe(200);
});

test("unknown routes 404 and throttled requests still hit the access log", async () => {
  const clock = new FakeClock();
  const app = buildApp({ clock, rateLimitPerWindow: 1, rateLimitWindowMs: 60_000 });

  const missing = await app.handle(reqAs("tok-alice", "/nope"));
  expect(missing.status).toBe(404);

  const throttled = await app.handle(reqAs("tok-alice"));
  expect(throttled.status).toBe(429);
  const aliceLogs = app.logs.forUser("alice");
  expect(aliceLogs.map((e) => e.status)).toEqual([404, 429]);
});
