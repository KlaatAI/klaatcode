// User service. Domain records use snake_case fields (legacy storage shape).
export interface RawUser {
  id: string;
  full_name: string;
  email: string;
  created_at: string;
  plan_tier: "free" | "pro" | "enterprise";
}

const USERS: RawUser[] = [
  {
    id: "u1",
    full_name: "Ada Lovelace",
    email: "ada@example.test",
    created_at: "2024-01-15T10:00:00.000Z",
    plan_tier: "pro",
  },
  {
    id: "u2",
    full_name: "Grace Hopper",
    email: "grace@example.test",
    created_at: "2024-03-02T08:30:00.000Z",
    plan_tier: "free",
  },
];

export function getUserById(id: string): RawUser | null {
  return USERS.find((user) => user.id === id) ?? null;
}
