import { test, expect } from "bun:test";
import { memoizeAsync } from "./memo";

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (err: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

test("concurrent calls with the same key invoke the loader exactly once", async () => {
  let calls = 0;
  const gate = deferred<string>();
  const memo = memoizeAsync<string>(() => {
    calls++;
    return gate.promise;
  });

  const all = Promise.all([memo("a"), memo("a"), memo("a"), memo("a"), memo("a")]);
  expect(calls).toBe(1);

  gate.resolve("value-a");
  expect(await all).toEqual(["value-a", "value-a", "value-a", "value-a", "value-a"]);
  expect(calls).toBe(1);
});

test("concurrency dedupes per key, not globally", async () => {
  const counts: Record<string, number> = {};
  const gates = new Map<string, ReturnType<typeof deferred<string>>>();
  const memo = memoizeAsync<string>((key) => {
    counts[key] = (counts[key] ?? 0) + 1;
    let gate = gates.get(key);
    if (!gate) {
      gate = deferred<string>();
      gates.set(key, gate);
    }
    return gate.promise;
  });

  const all = Promise.all([memo("a"), memo("b"), memo("a"), memo("b"), memo("a")]);
  expect(counts).toEqual({ a: 1, b: 1 });

  gates.get("a")!.resolve("A");
  gates.get("b")!.resolve("B");
  expect(await all).toEqual(["A", "B", "A", "B", "A"]);
  expect(counts).toEqual({ a: 1, b: 1 });
});

test("resolved values stay cached for sequential calls", async () => {
  const calls: string[] = [];
  const memo = memoizeAsync(async (key: string) => {
    calls.push(key);
    return key.toUpperCase();
  });

  expect(await memo("x")).toBe("X");
  expect(await memo("y")).toBe("Y");
  expect(await memo("x")).toBe("X");
  expect(await memo("y")).toBe("Y");
  expect(calls).toEqual(["x", "y"]);
});

test("a failed load rejects all concurrent waiters without extra loader calls", async () => {
  let calls = 0;
  const gate = deferred<string>();
  const memo = memoizeAsync<string>(() => {
    calls++;
    return gate.promise;
  });

  const p1 = memo("k");
  const p2 = memo("k");
  expect(calls).toBe(1);

  gate.reject(new Error("boom"));
  await expect(p1).rejects.toThrow("boom");
  await expect(p2).rejects.toThrow("boom");
  expect(calls).toBe(1);
});

test("a failure does not poison the cache: the next call retries and can succeed", async () => {
  let calls = 0;
  let currentGate = deferred<string>();
  const memo = memoizeAsync<string>(() => {
    calls++;
    return currentGate.promise;
  });

  const first = memo("k");
  currentGate.reject(new Error("transient"));
  await expect(first).rejects.toThrow("transient");
  expect(calls).toBe(1);

  currentGate = deferred<string>();
  const second = memo("k");
  expect(calls).toBe(2);
  currentGate.resolve("recovered");
  expect(await second).toBe("recovered");

  // The recovered value is now cached like any other success.
  expect(await memo("k")).toBe("recovered");
  expect(calls).toBe(2);
});
