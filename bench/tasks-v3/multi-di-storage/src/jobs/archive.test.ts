import { test, expect } from "bun:test";
import type { Storage } from "../storage/iface";
import { runArchiveJob } from "./archive";

class FakeStorage implements Storage {
  data = new Map<string, string>();
  calls: string[] = [];
  async get(key: string): Promise<string | null> {
    this.calls.push(`get:${key}`);
    return this.data.has(key) ? this.data.get(key)! : null;
  }
  async put(key: string, value: string): Promise<void> {
    this.calls.push(`put:${key}`);
    this.data.set(key, value);
  }
  async list(prefix: string): Promise<string[]> {
    this.calls.push(`list:${prefix}`);
    return [...this.data.keys()].filter((k) => k.startsWith(prefix)).sort();
  }
  async delete(key: string): Promise<boolean> {
    this.calls.push(`delete:${key}`);
    return this.data.delete(key);
  }
}

test("runArchiveJob moves reports into archive/ via the injected storage", async () => {
  const fake = new FakeStorage();
  fake.data.set("reports/r1", "first");
  fake.data.set("reports/r2", "second");
  const moved = await runArchiveJob(["r1", "r2"], fake);
  expect(moved).toBe(2);
  expect(fake.data.get("archive/r1")).toBe("first");
  expect(fake.data.get("archive/r2")).toBe("second");
  expect(fake.data.has("reports/r1")).toBe(false);
  expect(fake.data.has("reports/r2")).toBe(false);
});

test("runArchiveJob skips missing ids and counts only real moves", async () => {
  const fake = new FakeStorage();
  fake.data.set("reports/real", "data");
  const moved = await runArchiveJob(["ghost", "real"], fake);
  expect(moved).toBe(1);
  expect(fake.data.has("archive/ghost")).toBe(false);
  expect(fake.data.get("archive/real")).toBe("data");
});

test("runArchiveJob performs get -> put -> delete against the fake, in order", async () => {
  const fake = new FakeStorage();
  fake.data.set("reports/r9", "v");
  await runArchiveJob(["r9"], fake);
  expect(fake.calls).toEqual(["get:reports/r9", "put:archive/r9", "delete:reports/r9"]);
});
