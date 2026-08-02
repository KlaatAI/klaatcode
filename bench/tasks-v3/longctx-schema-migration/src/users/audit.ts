import type { AuditEntry } from "./types";
import type { Clock } from "../shared/clock";

/**
 * Append-only audit trail. Deterministic: order of entries is insertion
 * order and timestamps come from the injected clock.
 */
export class AuditLog {
  private readonly entries_: AuditEntry[] = [];

  constructor(private readonly clock: Clock, private readonly actor = "system") {}

  record(action: string, subjectId: string, detail?: string): AuditEntry {
    const entry: AuditEntry = {
      at: this.clock.now().toISOString(),
      actor: this.actor,
      action,
      subjectId,
      ...(detail !== undefined ? { detail } : {}),
    };
    this.entries_.push(entry);
    return { ...entry };
  }

  entries(): AuditEntry[] {
    return this.entries_.map((e) => ({ ...e }));
  }

  entriesFor(subjectId: string): AuditEntry[] {
    return this.entries().filter((e) => e.subjectId === subjectId);
  }

  /** Count of entries for a given action name (e.g. "settings.update"). */
  countByAction(action: string): number {
    return this.entries_.filter((e) => e.action === action).length;
  }
}
