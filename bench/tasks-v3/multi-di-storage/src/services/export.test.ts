import { test, expect } from "bun:test";
import type { Storage } from "../storage/iface";
import { ExportService } from "./export";

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

test("exportAll concatenates values from the injected storage in key order", async () => {
  const fake = new FakeStorage();
  fake.data.set("reports/b", "B1");
  fake.data.set("reports/a", "A1\nA2");
  fake.data.set("drafts/c", "ignored");
  const svc = new ExportService(fake);
  const out = await svc.exportAll("reports/");
  expect(out).toBe("## reports/a\nA1\nA2\n\n## reports/b\nB1");
  expect(fake.calls[0]).toBe("list:reports/");
  expect(fake.calls).toContain("get:reports/a");
  expect(fake.calls).toContain("get:reports/b");
});

test("exportManifest reports utf-8 byte sizes from the injected storage", async () => {
  const fake = new FakeStorage();
  fake.data.set("reports/x", "abc");
  fake.data.set("reports/y", "héllo"); // é is 2 bytes in utf-8
  const svc = new ExportService(fake);
  expect(await svc.exportManifest("reports/")).toEqual([
    { key: "reports/x", bytes: 3 },
    { key: "reports/y", bytes: 6 },
  ]);
});

test("exportAll of an empty prefix produces an empty string and no gets", async () => {
  const fake = new FakeStorage();
  const svc = new ExportService(fake);
  expect(await svc.exportAll("reports/")).toBe("");
  expect(fake.calls).toEqual(["list:reports/"]);
});
