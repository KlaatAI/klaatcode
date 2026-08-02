import { validateEmail, validateName, validateCountry } from "../validation/core";

export interface SignupInput {
  email: string;
  name: string;
  country: string;
}

export interface User {
  id: string;
  email: string;
  name: string;
  country: string;
}

let seq = 0;

export function signupUser(input: SignupInput): User {
  const email = validateEmail(input.email, "email");
  const name = validateName(input.name, "name");
  const country = validateCountry(input.country, "country");
  return { id: `u_${++seq}`, email, name, country };
}
