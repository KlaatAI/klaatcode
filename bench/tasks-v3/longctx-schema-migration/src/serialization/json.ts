import type { User, UserStatus } from "../users/types";

/**
 * Explicit JSON (de)serialization for the public API. Field mapping is
 * spelled out — never `JSON.stringify(user)` directly — so schema changes
 * (like migration 0007's nickname -> displayName rename) are visible here.
 */

export interface UserWire {
  id: string;
  email: string;
  display_name: string;
  full_name: string;
  locale: string;
  timezone: string;
  created_at: string;
  status: UserStatus;
}

export function toWire(user: User): UserWire {
  return {
    id: user.id,
    email: user.email,
    display_name: user.displayName,
    full_name: user.fullName,
    locale: user.locale,
    timezone: user.timezone,
    created_at: user.createdAt,
    status: user.status,
  };
}

export function fromWire(wire: UserWire): User {
  return {
    id: wire.id,
    email: wire.email,
    displayName: wire.display_name,
    fullName: wire.full_name,
    locale: wire.locale,
    timezone: wire.timezone,
    createdAt: wire.created_at,
    status: wire.status,
  };
}

export function serializeUser(user: User): string {
  return JSON.stringify(toWire(user));
}

export function deserializeUser(json: string): User {
  const parsed = JSON.parse(json) as Partial<UserWire>;
  const required: (keyof UserWire)[] = [
    "id", "email", "display_name", "full_name", "locale", "timezone", "created_at", "status",
  ];
  for (const key of required) {
    if (parsed[key] === undefined) {
      throw new Error(`deserializeUser: missing field ${key}`);
    }
  }
  return fromWire(parsed as UserWire);
}
