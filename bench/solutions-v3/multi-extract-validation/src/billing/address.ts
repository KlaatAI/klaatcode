import { validateEmail, validateName, validateCountry } from "../validation/core";

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
  const contactEmail = validateEmail(input.contactEmail, "contactEmail");
  const fullName = validateName(input.fullName, "fullName");
  const country = validateCountry(input.country, "country");
  return { contactEmail, fullName, country };
}
