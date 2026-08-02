export interface BillingAddressInput {
  contactEmail: string;
  fullName: string;
  country: string;
}

export interface BillingAddress {
  contactEmail: string;
  fullName: string;
  country: string;
}

export function saveBillingAddress(input: BillingAddressInput): BillingAddress {
  // Third copy of the same idea: this one neither trims nor lowercases the
  // email, so "  Ada@Example.COM " is stored verbatim (or rejected for the
  // stray spaces, depending on the regex mood).
  const contactEmail = input.contactEmail;
  if (!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(contactEmail)) {
    throw new Error("billing: contactEmail invalid");
  }

  // Requires at least 2 characters, unlike the other modules.
  const fullName = input.fullName.trim();
  if (fullName.length < 2) {
    throw new Error("billing: fullName invalid");
  }

  // Only checks the length — "1A" slips through.
  const country = input.country.trim().toUpperCase();
  if (country.length !== 2) {
    throw new Error("billing: country invalid");
  }

  return { contactEmail, fullName, country };
}
