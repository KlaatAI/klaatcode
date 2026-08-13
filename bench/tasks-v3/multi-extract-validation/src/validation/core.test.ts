import { test, expect } from "bun:test";
import { ValidationError, validateEmail, validateName, validateCountry } from "./core";
import { signupUser } from "../signup/user";
import { createProject } from "../projects/create";
import { saveBillingAddress } from "../billing/address";

test("validateEmail trims, lowercases, and returns the normalized address", () => {
  expect(validateEmail("  Ada@Example.COM ")).toBe("ada@example.com");
  expect(validateEmail("grace.hopper+tag@Navy.MIL")).toBe("grace.hopper+tag@navy.mil");
});

test("validateEmail rejects invalid addresses with a ValidationError carrying the field", () => {
  expect(() => validateEmail("not-an-email")).toThrow(ValidationError);
  expect(() => validateEmail("a@b")).toThrow(ValidationError); // no dot in domain
  try {
    validateEmail("nope", "ownerEmail");
    throw new Error("should have thrown");
  } catch (e) {
    expect(e).toBeInstanceOf(ValidationError);
    expect((e as ValidationError).field).toBe("ownerEmail");
    expect((e as ValidationError).name).toBe("ValidationError");
  }
});

test("validateName trims and enforces 1-80 chars", () => {
  expect(validateName("  Grace Hopper  ")).toBe("Grace Hopper");
  expect(validateName("X")).toBe("X"); // single char is fine
  expect(() => validateName("   ")).toThrow(ValidationError);
  expect(() => validateName("x".repeat(81))).toThrow(ValidationError);
  try {
    validateName("", "fullName");
    throw new Error("should have thrown");
  } catch (e) {
    expect((e as ValidationError).field).toBe("fullName");
  }
});

test("validateCountry trims, uppercases, and requires exactly two letters", () => {
  expect(validateCountry(" de ")).toBe("DE");
  expect(validateCountry("gb")).toBe("GB");
  expect(() => validateCountry("USA")).toThrow(ValidationError);
  expect(() => validateCountry("1a")).toThrow(ValidationError);
  expect(() => validateCountry("U1")).toThrow(ValidationError);
});

test("all three modules normalize the same messy input identically", () => {
  const rawEmail = "  Mixed.Case+tag@EXAMPLE.com ";
  const u = signupUser({ email: rawEmail, name: "Ada", country: " fr " });
  const p = createProject({ name: "Apollo", ownerEmail: rawEmail, country: " fr " });
  const b = saveBillingAddress({ contactEmail: rawEmail, fullName: "Ada", country: " fr " });

  expect(u.email).toBe("mixed.case+tag@example.com");
  expect(p.ownerEmail).toBe(u.email);
  expect(b.contactEmail).toBe(u.email);
  expect(u.country).toBe("FR");
  expect(p.country).toBe("FR");
  expect(b.country).toBe("FR");
});
