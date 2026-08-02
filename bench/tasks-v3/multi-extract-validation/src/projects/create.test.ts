import { test, expect } from "bun:test";
import { createProject } from "./create";
import { ValidationError } from "../validation/core";

test("createProject normalizes ownerEmail (lowercase) and country (uppercase)", () => {
  const p = createProject({ name: "  Apollo  ", ownerEmail: " Team@Corp.IO ", country: "gb" });
  expect(p.ownerEmail).toBe("team@corp.io");
  expect(p.name).toBe("Apollo");
  expect(p.country).toBe("GB");
});

test("createProject rejects a bad email with field 'ownerEmail'", () => {
  try {
    createProject({ name: "Apollo", ownerEmail: "no-at-sign", country: "GB" });
    throw new Error("should have thrown");
  } catch (e) {
    expect(e).toBeInstanceOf(ValidationError);
    expect((e as ValidationError).field).toBe("ownerEmail");
  }
});

test("createProject rejects a whitespace-only name with field 'name'", () => {
  try {
    createProject({ name: "   ", ownerEmail: "team@corp.io", country: "GB" });
    throw new Error("should have thrown");
  } catch (e) {
    expect(e).toBeInstanceOf(ValidationError);
    expect((e as ValidationError).field).toBe("name");
  }
});
