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
  // Inline validation, written long before the shared core existed.
  // Lowercases the email but forgets to trim it, and its regex does not
  // require a dot in the domain.
  const email = input.email.toLowerCase();
  if (!/^\S+@\S+$/.test(email)) {
    throw new Error("signup: bad email");
  }

  // Name is only checked for emptiness — leading/trailing spaces survive.
  const name = input.name;
  if (name.length === 0) {
    throw new Error("signup: bad name");
  }

  // Uppercases, but the character class accidentally admits digits ("U1").
  const country = input.country.toUpperCase().trim();
  if (!/^[A-Z0-9]{2}$/.test(country)) {
    throw new Error("signup: bad country");
  }

  return { id: `u_${++seq}`, email, name, country };
}
