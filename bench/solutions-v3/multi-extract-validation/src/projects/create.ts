import { validateEmail, validateName, validateCountry } from "../validation/core";

export interface ProjectInput {
  name: string;
  ownerEmail: string;
  country: string;
}

export interface Project {
  id: string;
  name: string;
  ownerEmail: string;
  country: string;
}

let seq = 0;

export function createProject(input: ProjectInput): Project {
  const name = validateName(input.name, "name");
  const ownerEmail = validateEmail(input.ownerEmail, "ownerEmail");
  const country = validateCountry(input.country, "country");
  return { id: `p_${++seq}`, name, ownerEmail, country };
}
