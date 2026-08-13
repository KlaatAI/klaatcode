import { describe, expect, test } from "bun:test";
import { validateSchema, extractJson, encodeEvent, type JsonSchema } from "./headless-contract.js";

describe("validateSchema", () => {
  const schema: JsonSchema = {
    type: "object",
    required: ["severity", "files"],
    properties: {
      severity: { type: "string", enum: ["low", "high"] },
      files: { type: "array", items: { type: "string" } },
      count: { type: "integer" },
    },
  };
  test("valid object passes", () => {
    expect(validateSchema({ severity: "high", files: ["a.ts"], count: 2 }, schema)).toEqual([]);
  });
  test("missing required property", () => {
    expect(validateSchema({ severity: "low" }, schema)).toContain("$.files: required property missing");
  });
  test("enum violation", () => {
    expect(validateSchema({ severity: "medium", files: [] }, schema).some(e => e.includes("enum"))).toBe(true);
  });
  test("wrong nested item type", () => {
    expect(validateSchema({ severity: "low", files: [1] }, schema).some(e => e.includes("files[0]"))).toBe(true);
  });
  test("integer rejects float", () => {
    expect(validateSchema({ severity: "low", files: [], count: 1.5 }, schema).some(e => e.includes("count"))).toBe(true);
  });
});

describe("extractJson", () => {
  test("fenced json block", () => {
    expect(extractJson('Here it is:\n```json\n{"a":1}\n```')).toEqual({ a: 1 });
  });
  test("bare object amid prose", () => {
    expect(extractJson('The result is {"ok": true, "n": 3} done.')).toEqual({ ok: true, n: 3 });
  });
  test("array span", () => {
    expect(extractJson("output: [1, 2, 3]")).toEqual([1, 2, 3]);
  });
  test("brace inside a string does not confuse the matcher", () => {
    expect(extractJson('{"msg": "a } b", "x": 1}')).toEqual({ msg: "a } b", x: 1 });
  });
  test("no json returns null", () => {
    expect(extractJson("just prose, nothing structured")).toBeNull();
  });
});

describe("encodeEvent", () => {
  test("one line per event", () => {
    const s = encodeEvent({ type: "tool", name: "read_file" });
    expect(s.endsWith("\n")).toBe(true);
    expect(JSON.parse(s.trim())).toEqual({ type: "tool", name: "read_file" });
  });
});
