/**
 * Canonical user model types.
 *
 * Schema history lives in MIGRATIONS.md at the repo root. The most recent
 * schema-affecting change is migration 0007, which renamed the legacy
 * `nickname` field to `displayName`. The model below reflects the
 * post-migration shape: there is no `nickname` property anywhere.
 */

export type UserStatus = "active" | "suspended" | "deleted";

export interface User {
  /** Opaque stable identifier, e.g. "u_0001". */
  id: string;
  /** Unique, lowercased email address. */
  email: string;
  /**
   * Canonical human-readable name shown across the product.
   * Renamed from `nickname` in migration 0007; always non-empty.
   */
  displayName: string;
  /** Legal/full name as entered at signup. May contain spaces. */
  fullName: string;
  /** BCP-47 locale tag, e.g. "en-US". */
  locale: string;
  /** IANA timezone name, e.g. "Asia/Tokyo" (migration 0005). */
  timezone: string;
  /** ISO-8601 creation timestamp. */
  createdAt: string;
  /** Lifecycle state (migration 0006). */
  status: UserStatus;
}

export type DigestFrequency = "daily" | "weekly" | "never";

export interface UserPreferences {
  userId: string;
  theme: "light" | "dark" | "system";
  digestFrequency: DigestFrequency;
  marketingOptIn: boolean;
  /** Local hour (0-23) at which digests should be delivered. */
  digestHour: number;
}

/** Read-model returned by the profile service for UI consumption. */
export interface ProfileView {
  id: string;
  heading: string;
  subtitle: string;
  memberSince: string;
  badges: string[];
}

/** Shape of a single audit trail entry. */
export interface AuditEntry {
  at: string;
  actor: string;
  action: string;
  subjectId: string;
  detail?: string;
}

export function isActive(user: User): boolean {
  return user.status === "active";
}

export function defaultPreferences(userId: string): UserPreferences {
  return {
    userId,
    theme: "system",
    digestFrequency: "weekly",
    marketingOptIn: false,
    digestHour: 9,
  };
}
