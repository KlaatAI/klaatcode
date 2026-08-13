import type { ProfileView, User } from "./types";
import { UserStore } from "./store";
import type { Clock } from "../shared/clock";

/** Human-friendly "member since" label, derived from createdAt. */
function memberSinceLabel(user: User): string {
  const d = new Date(user.createdAt);
  const months = [
    "January", "February", "March", "April", "May", "June",
    "July", "August", "September", "October", "November", "December",
  ];
  return `${months[d.getUTCMonth()]} ${d.getUTCFullYear()}`;
}

function badgesFor(user: User, now: Date): string[] {
  const badges: string[] = [];
  const ageMs = now.getTime() - Date.parse(user.createdAt);
  const days = ageMs / 86_400_000;
  if (days >= 365) badges.push("veteran");
  else if (days <= 30) badges.push("new");
  if (user.locale.startsWith("en")) badges.push("english-ui");
  return badges;
}

/**
 * Read-side profile service. Produces the `ProfileView` consumed by the
 * web and CLI frontends. Uses `displayName` as the canonical name field
 * (migration 0007).
 */
export class ProfileService {
  constructor(private readonly store: UserStore, private readonly clock: Clock) {}

  renderProfile(userId: string): ProfileView {
    const user = this.store.get(userId);
    return {
      id: user.id,
      heading: user.displayName,
      subtitle: `${user.fullName} · ${user.locale}`,
      memberSince: `Member since ${memberSinceLabel(user)}`,
      badges: badgesFor(user, this.clock.now()),
    };
  }

  /** Compact one-line summary used by admin tooling and logs. */
  profileSummaryLine(userId: string): string {
    const user = this.store.get(userId);
    const status = user.status === "active" ? "" : ` [${user.status}]`;
    return `${user.displayName} <${user.email}>${status}`;
  }

  /**
   * Initials for the avatar placeholder. Derived from displayName,
   * falling back to the email local part when the name is one word.
   */
  avatarInitials(userId: string): string {
    const user = this.store.get(userId);
    const parts = user.displayName.split(/\s+/).filter((p) => p.length > 0);
    if (parts.length >= 2) {
      return (parts[0]![0]! + parts[parts.length - 1]![0]!).toUpperCase();
    }
    return user.displayName.slice(0, 2).toUpperCase();
  }
}
