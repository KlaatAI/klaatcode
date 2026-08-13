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
  // Another hand-rolled validator: trims the email but never lowercases it,
  // and only checks that an "@" is present somewhere.
  const ownerEmail = input.ownerEmail.trim();
  if (!ownerEmail.includes("@")) {
    throw new Error("project: invalid ownerEmail");
  }

  const name = input.name.trim();
  if (name === "") {
    throw new Error("project: invalid name");
  }

  // Trims but never uppercases — "gb" is stored as-is.
  const country = input.country.trim();
  if (!/^[A-Za-z]{2}$/.test(country)) {
    throw new Error("project: invalid country");
  }

  return { id: `p_${++seq}`, name, ownerEmail, country };
}
