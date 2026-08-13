import type { UserPreferences } from "./types";
import { UserStore } from "./store";
import { AuditLog } from "./audit";

export interface SettingsPatch {
  theme?: UserPreferences["theme"];
  digestFrequency?: UserPreferences["digestFrequency"];
  marketingOptIn?: boolean;
  digestHour?: number;
}

/**
 * Write-side settings service. All preference mutations flow through here
 * so the audit trail stays complete.
 */
export class SettingsService {
  constructor(private readonly store: UserStore, private readonly audit: AuditLog) {}

  getSettings(userId: string): UserPreferences {
    return this.store.getPreferences(userId);
  }

  updateSettings(userId: string, patch: SettingsPatch): UserPreferences {
    const before = this.store.getPreferences(userId);
    const after = this.store.updatePreferences(userId, patch);
    const changed = this.describeChanges(before, after);
    if (changed.length > 0) {
      this.audit.record("settings.update", userId, changed.join(", "));
    }
    return after;
  }

  /** Whether the user should receive a digest at all. */
  digestEnabled(userId: string): boolean {
    const prefs = this.store.getPreferences(userId);
    if (prefs.digestFrequency === "never") return false;
    const user = this.store.get(userId);
    return user.status === "active";
  }

  /**
   * The UTC hour at which the user's digest should be sent. The fixture
   * keeps a tiny static offset table instead of a real tz database so the
   * computation is deterministic.
   */
  digestUtcHour(userId: string): number {
    const prefs = this.store.getPreferences(userId);
    const user = this.store.get(userId);
    const offsets: Record<string, number> = {
      "UTC": 0,
      "Europe/Berlin": 1,
      "Asia/Tokyo": 9,
      "America/New_York": -5,
      "Australia/Sydney": 10,
    };
    const offset = offsets[user.timezone] ?? 0;
    return ((prefs.digestHour - offset) % 24 + 24) % 24;
  }

  private describeChanges(before: UserPreferences, after: UserPreferences): string[] {
    const changed: string[] = [];
    for (const key of ["theme", "digestFrequency", "marketingOptIn", "digestHour"] as const) {
      if (before[key] !== after[key]) {
        changed.push(`${key}: ${String(before[key])} -> ${String(after[key])}`);
      }
    }
    return changed;
  }
}
