import { test, expect } from "bun:test";
import type { Storage } from "../storage/iface";
import { ReportService } from "./reports";

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

test("save writes through the injected storage", async () => {
  const fake = new FakeStorage();
  const svc = new ReportService(fake);
  const key = await svc.save("w1", ["alpha", "beta"]);
  expect(key).toBe("reports/w1");
  expect(fake.data.get("reports/w1")).toBe("alpha\nbeta");
  expect(fake.calls).toContain("put:reports/w1");
});

test("load reads from the injected storage and returns null for missing ids", async () => {
  const fake = new FakeStorage();
  fake.data.set("reports/w2", "one\ntwo\nthree");
  const svc = new ReportService(fake);
  expect(await svc.load("w2")).toEqual(["one", "two", "three"]);
  expect(await svc.load("nope")).toBeNull();
  expect(fake.calls).toContain("get:reports/w2");
});

test("listIds lists only report keys from the injected storage, sorted", async () => {
  const fake = new FakeStorage();
  fake.data.set("reports/zeta", "z");
  fake.data.set("reports/alpha", "a");
  fake.data.set("other/junk", "x");
  const svc = new ReportService(fake);
  expect(await svc.listIds()).toEqual(["alpha", "zeta"]);
  expect(fake.calls).toContain("list:reports/");
});

test("remove deletes through the injected storage", async () => {
  const fake = new FakeStorage();
  fake.data.set("reports/w3", "bye");
  const svc = new ReportService(fake);
  expect(await svc.remove("w3")).toBe(true);
  expect(fake.data.has("reports/w3")).toBe(false);
  expect(await svc.remove("w3")).toBe(false);
});

test("two services with different fakes are fully isolated", async () => {
  const fakeA = new FakeStorage();
  const fakeB = new FakeStorage();
  const a = new ReportService(fakeA);
  const b = new ReportService(fakeB);
  await a.save("only-a", ["A"]);
  expect(await b.load("only-a")).toBeNull();
  expect(fakeB.data.size).toBe(0);
});

test("the default constructor still works against the real FileStore", async () => {
  const svc = new ReportService();
  await svc.save("default-1", ["from disk"]);
  expect(await svc.load("default-1")).toEqual(["from disk"]);
});
