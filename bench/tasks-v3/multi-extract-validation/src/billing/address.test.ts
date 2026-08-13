import { test, expect } from "bun:test";
import { saveBillingAddress } from "./address";
import { ValidationError } from "../validation/core";

test("saveBillingAddress normalizes the contact email like every other module", () => {
  const a = saveBillingAddress({
    contactEmail: "  Billing@Acme.COM ",
    fullName: "  Acme Accounts  ",
    country: " us ",
  });
  expect(a.contactEmail).toBe("billing@acme.com");
  expect(a.fullName).toBe("Acme Accounts");
  expect(a.country).toBe("US");
});

test("saveBillingAddress accepts a single-character full name (unified 1-80 rule)", () => {
  const a = saveBillingAddress({ contactEmail: "x@y.co", fullName: "X", country: "US" });
  expect(a.fullName).toBe("X");
});

test("saveBillingAddress rejects a country code containing a digit", () => {
  expect(() =>
    saveBillingAddress({ contactEmail: "x@y.co", fullName: "Ada", country: "1A" }),
  ).toThrow(ValidationError);
});

test("saveBillingAddress reports the failing field on bad email", () => {
  try {
    saveBillingAddress({ contactEmail: "bad", fullName: "Ada", country: "US" });
    throw new Error("should have thrown");
  } catch (e) {
    expect(e).toBeInstanceOf(ValidationError);
    expect((e as ValidationError).field).toBe("contactEmail");
  }
});
