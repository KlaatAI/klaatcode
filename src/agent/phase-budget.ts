/**
 * Per-phase token budgets (roadmap 9.5).
 *
 * A session-total budget can't catch the classic stuck-agent signature: the
 * whole budget burned in exploration before a single line is written. This
 * tracker infers the agent's phase from the tools each round actually used
 * (mutating tools = implement, command/shell = verify, read-only = explore),
 * attributes every response's tokens to the current phase, and raises:
 *
 *   - "pause" when the EXPLORE budget is exhausted with no artifact produced
 *     (the caller should stop agent rounds and ask the user), or
 *   - "warn" when any other phase passes its soft budget (informational).
 *
 * One event per task; reset() on each new user message.
 */

export type AgentPhase = "explore" | "implement" | "verify";

export interface PhaseEvent {
  kind: "pause" | "warn";
  phase: AgentPhase;
  used: number;
  budget: number;
}

export const DEFAULT_PHASE_BUDGETS: Record<AgentPhase, number> = {
  explore: 60_000,
  implement: 150_000,
  verify: 80_000,
};

const MUTATING_TOOLS = new Set(["write_file", "edit_file", "multi_edit", "apply_patch"]);
const VERIFY_TOOLS   = new Set(["run_command", "shell_output"]);

export class PhaseTracker {
  readonly budgets: Record<AgentPhase, number>;
  private readonly enabled: boolean;

  tokens: Record<AgentPhase, number> = { explore: 0, implement: 0, verify: 0 };
  phase: AgentPhase = "explore";
  /** Has this task produced a concrete artifact (an edit) yet? */
  hasArtifact = false;
  /** Set once the explore budget pauses the loop; cleared by reset(). */
  paused = false;
  private warned = false;

  constructor(opts: { budgets?: Partial<Record<AgentPhase, number>>; enabled?: boolean } = {}) {
    this.budgets = { ...DEFAULT_PHASE_BUDGETS, ...opts.budgets };
    this.enabled = opts.enabled ?? true;
  }

  /** New user task: fresh phase state; a new message clears a pause. */
  reset(): void {
    this.tokens = { explore: 0, implement: 0, verify: 0 };
    this.phase = "explore";
    this.hasArtifact = false;
    this.warned = false;
    this.paused = false;
  }

  /** Reclassify the phase from the tools of the round just executed.
   * Priority: any mutation → implement; else any command → verify; else explore. */
  noteTools(toolNames: string[]): void {
    if (toolNames.some(n => MUTATING_TOOLS.has(n))) {
      this.phase = "implement";
      this.hasArtifact = true;
    } else if (toolNames.some(n => VERIFY_TOOLS.has(n))) {
      this.phase = "verify";
    } else if (toolNames.length > 0) {
      this.phase = "explore";
    }
  }

  /** Attribute a response's tokens to the current phase; returns at most one
   * budget event per task (null otherwise). */
  addUsage(totalTokens: number): PhaseEvent | null {
    if (!this.enabled) return null;
    this.tokens[this.phase] += totalTokens;
    if (this.warned || this.tokens[this.phase] <= this.budgets[this.phase]) return null;
    this.warned = true;
    const ev: PhaseEvent = {
      kind: this.phase === "explore" && !this.hasArtifact ? "pause" : "warn",
      phase: this.phase,
      used: this.tokens[this.phase],
      budget: this.budgets[this.phase],
    };
    if (ev.kind === "pause") this.paused = true;
    return ev;
  }
}
