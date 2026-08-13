import { test, expect } from "bun:test";
import { signupUser } from "./user";
import { ValidationError } from "../validation/core";

test("signupUser normalizes email, name, and country per the unified rules", () => {
  const u = signupUser({ email: "  Ada@Example.COM ", name: " Ada Lovelace ", country: " de " });
  expect(u.email).toBe("ada@example.com");
  expect(u.name).toBe("Ada Lovelace"); // trimmed
  expect(u.country).toBe("DE");
});

test("signupUser rejects a dotless domain with a typed ValidationError", () => {
  try {
    signupUser({ email: "a@b", name: "Ada", country: "DE" });
    throw new Error("should have thrown");
  } catch (e) {
    expect(e).toBeInstanceOf(ValidationError);
    expect((e as ValidationError).field).toBe("email");
  }
});

test("signupUser rejects a digit in the country code", () => {
  expect(() => signupUser({ email: "a@b.co", name: "Ada", country: "U1" })).toThrow(ValidationError);
});
