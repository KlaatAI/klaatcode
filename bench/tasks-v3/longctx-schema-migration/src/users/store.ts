import type { User, UserPreferences } from "./types";
import { defaultPreferences } from "./types";
import { assertValidPreferences, assertValidUser } from "./validation";
import { IdGenerator } from "../shared/ids";

export class NotFoundError extends Error {
  constructor(kind: string, id: string) {
    super(`${kind} not found: ${id}`);
    this.name = "NotFoundError";
  }
}

export interface CreateUserInput {
  email: string;
  displayName: string;
  fullName: string;
  locale?: string;
  timezone?: string;
  createdAt?: string;
}

/**
 * In-memory user store. Owns the canonical `User` records; every service
 * reads through here. Records always match the post-migration schema in
 * src/users/types.ts (see MIGRATIONS.md, entry 0007).
 */
export class UserStore {
  private readonly users = new Map<string, User>();
  private readonly prefs = new Map<string, UserPreferences>();
  private readonly ids = new IdGenerator("u");

  create(input: CreateUserInput): User {
    const user: User = {
      id: this.ids.next(),
      email: input.email.toLowerCase(),
      displayName: input.displayName,
      fullName: input.fullName,
      locale: input.locale ?? "en-US",
      timezone: input.timezone ?? "UTC",
      createdAt: input.createdAt ?? "2026-01-01T00:00:00.000Z",
      status: "active",
    };
    assertValidUser(user);
    this.users.set(user.id, user);
    this.prefs.set(user.id, defaultPreferences(user.id));
    return { ...user };
  }

  get(id: string): User {
    const user = this.users.get(id);
    if (!user) throw new NotFoundError("user", id);
    return { ...user };
  }

  findByEmail(email: string): User | undefined {
    const needle = email.toLowerCase();
    for (const user of this.users.values()) {
      if (user.email === needle) return { ...user };
    }
    return undefined;
  }

  update(id: string, patch: Partial<Omit<User, "id">>): User {
    const current = this.users.get(id);
    if (!current) throw new NotFoundError("user", id);
    const next: User = { ...current, ...patch, id: current.id };
    assertValidUser(next);
    this.users.set(id, next);
    return { ...next };
  }

  /** Soft-delete per migration 0006: record stays, status flips. */
  markDeleted(id: string): void {
    this.update(id, { status: "deleted" });
  }

  list(): User[] {
    return [...this.users.values()]
      .map((u) => ({ ...u }))
      .sort((a, b) => a.id.localeCompare(b.id));
  }

  listActive(): User[] {
    return this.list().filter((u) => u.status === "active");
  }

  getPreferences(userId: string): UserPreferences {
    const prefs = this.prefs.get(userId);
    if (!prefs) throw new NotFoundError("preferences", userId);
    return { ...prefs };
  }

  updatePreferences(userId: string, patch: Partial<Omit<UserPreferences, "userId">>): UserPreferences {
    const current = this.prefs.get(userId);
    if (!current) throw new NotFoundError("preferences", userId);
    const next: UserPreferences = { ...current, ...patch, userId };
    assertValidPreferences(next);
    this.prefs.set(userId, next);
    return { ...next };
  }

  size(): number {
    return this.users.size;
  }
}
