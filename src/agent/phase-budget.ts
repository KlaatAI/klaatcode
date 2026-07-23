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
 * The explore budget is NOT a fixed number — it scales to the served tier's
 * context window (see scaleForWindow). A 60K cap made sense on a 32K cheap
 * tier, but on a 118K-window tier legitimate deep exploration (reading many
 * files, comparing large data) easily processes 60-80K without being "stuck".
 * A "produced an artifact" is EITHER an edit OR a real textual answer — an
 * analysis/comparison task never edits, it answers, and must not be flagged
 * stuck for doing exactly that.
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

/** Explore budget = max(default, window × this). Generous on big tiers so
 * legitimate deep exploration doesn't false-trip; the doom-loop repetition
 * detector remains the reliable "truly stuck" signal. */
const EXPLORE_WINDOW_MULTIPLIER = 1.5;

/** Output tokens in a SINGLE response that count as "the agent answered".
 * A real answer is one substantial response — not narration ("let me check…")
 * drip-accumulated across many rounds, which must NOT disarm the pause. Once a
 * genuine answer is produced, the explore pause downgrades to a soft warn. */
const ANSWER_OUTPUT_TOKENS = 600;

const MUTATING_TOOLS = new Set(["write_file", "edit_file", "multi_edit", "apply_patch", "create_file", "edit_block"]);
const VERIFY_TOOLS   = new Set(["run_command", "shell_output", "shell"]);

/** Strip an MCP prefix ("mcp__<server>__write_file" → "write_file") so MCP
 * filesystem/shell tools are classified the same as native ones — otherwise an
 * MCP-based build looks like endless "explore" (no artifact ever recorded). */
function baseToolName(name: string): string {
  return name.includes("__") ? name.slice(name.lastIndexOf("__") + 2) : name;
}

export class PhaseTracker {
  readonly budgets: Record<AgentPhase, number>;
  private readonly enabled: boolean;
  /** Base explore budget before the Continue enlargement; tracks scaleForWindow. */
  private baseExplore: number;

  tokens: Record<AgentPhase, number> = { explore: 0, implement: 0, verify: 0 };
  phase: AgentPhase = "explore";
  /** Has this task produced a concrete artifact (an edit) yet? */
  hasArtifact = false;
  /** Cumulative assistant output tokens this task (shown for observability). */
  outputTokens = 0;
  /** Set once any single response produced a substantive answer (≥ threshold). */
  answered = false;
  /** Set once the explore budget pauses the loop; cleared by reset(). */
  paused = false;
  private warned = false;

  constructor(opts: { budgets?: Partial<Record<AgentPhase, number>>; enabled?: boolean } = {}) {
    this.budgets = { ...DEFAULT_PHASE_BUDGETS, ...opts.budgets };
    this.enabled = opts.enabled ?? true;
    this.baseExplore = this.budgets.explore;
  }

  /** True once the agent has produced a deliverable — an edit OR a substantive
   * textual answer. Either means it is not silently stuck reading. */
  private get producedArtifact(): boolean {
    return this.hasArtifact || this.answered;
  }

  /** Scale the explore budget to the served tier's context window. Called when
   * the tier/window is known (and may change mid-session via router escalation).
   * Keeps the DEFAULT as a floor for small tiers. */
  scaleForWindow(windowTokens: number): void {
    if (!windowTokens || windowTokens <= 0) return;
    const scaled = Math.max(
      DEFAULT_PHASE_BUDGETS.explore,
      Math.round(windowTokens * EXPLORE_WINDOW_MULTIPLIER),
    );
    this.baseExplore = scaled;
    // Don't shrink an already-enlarged (post-Continue) budget below the resume level.
    if (!this.paused) this.budgets.explore = Math.max(this.budgets.explore, scaled);
  }

  /** New user task: fresh phase state; a new message clears a pause. */
  reset(): void {
    this.tokens = { explore: 0, implement: 0, verify: 0 };
    this.phase = "explore";
    this.hasArtifact = false;
    this.outputTokens = 0;
    this.answered = false;
    this.warned = false;
    this.paused = false;
    this.budgets.explore = this.baseExplore;
  }

  /** User chose Continue at the explore pause. Clear the pause and start a
   * fresh explore count, but with a LARGER budget than the current base so the
   * resumed attempt cannot hit the identical wall at the identical point and
   * loop forever. `hasArtifact` is preserved (don't wipe the progress signal). */
  resumeAfterContinue(): void {
    this.tokens = { explore: 0, implement: 0, verify: 0 };
    this.phase = "explore";
    this.warned = false;
    this.paused = false;
    this.budgets.explore = Math.round(this.baseExplore * 1.6);
  }

  /** Reclassify the phase from the tools of the round just executed.
   * Priority: any mutation → implement; else any command → verify; else explore. */
  noteTools(toolNames: string[]): void {
    const bases = toolNames.map(baseToolName);
    if (bases.some(n => MUTATING_TOOLS.has(n))) {
      this.phase = "implement";
      this.hasArtifact = true;
    } else if (bases.some(n => VERIFY_TOOLS.has(n))) {
      this.phase = "verify";
    } else if (toolNames.length > 0) {
      this.phase = "explore";
    }
  }

  /** Attribute a response's tokens to the current phase; returns at most one
   * budget event per task (null otherwise).
   *
   * `completionTokens` feeds the answer signal (a real answer ≥ threshold =
   * artifact). `opts.loopSuspected` is the caller's doom-loop signal for THIS
   * round (identical tool call/results repeated). The explore overage only HARD
   * PAUSES when there is actual evidence of being stuck — a repetition loop, or
   * a runaway 2× past budget. Otherwise it's a soft WARN: token count alone is a
   * poor "stuck" proxy (legit big-data analysis reads a lot without repeating),
   * and cost is separately bounded by maxSessionCost + burn-rate. */
  addUsage(
    totalTokens: number,
    completionTokens = 0,
    opts: { loopSuspected?: boolean } = {},
  ): PhaseEvent | null {
    if (!this.enabled) return null;
    this.tokens[this.phase] += totalTokens;
    this.outputTokens += completionTokens;
    if (completionTokens >= ANSWER_OUTPUT_TOKENS) this.answered = true;
    if (this.warned || this.tokens[this.phase] <= this.budgets[this.phase]) return null;
    this.warned = true;
    const overBudgetNoArtifact = this.phase === "explore" && !this.producedArtifact;
    const runaway = this.tokens[this.phase] > this.budgets[this.phase] * 2;
    const stuck = overBudgetNoArtifact && (opts.loopSuspected === true || runaway);
    const ev: PhaseEvent = {
      kind: stuck ? "pause" : "warn",
      phase: this.phase,
      used: this.tokens[this.phase],
      budget: this.budgets[this.phase],
    };
    if (ev.kind === "pause") this.paused = true;
    return ev;
  }
}
