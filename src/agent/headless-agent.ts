/**
 * Headless agent loop — the REPL's tool-calling loop with the TUI stripped out.
 *
 * Given a client + seed messages, it runs the full multi-turn agentic loop
 * (stream → tool calls → execute → feed results → repeat) to completion and
 * returns hard metrics: tokens, cost, tiers used, tool calls, wall-clock.
 *
 * Reused by: `klaatai bench` (Phase 7 harness), and later `klaatai run --agent`
 * and background sub-agents (3.3). NO permission prompts — every tool auto-runs,
 * so callers MUST sandbox the workspace (bench copies fixtures to a temp dir).
 */

import { KlaatAIClient, type Message, type ToolCall, type ToolDefinition } from "../api/client.js";
import { executeTools, TOOL_DEFINITIONS } from "../tools/index.js";
import { compactMessagesForApi } from "./compaction.js";

export interface HeadlessResult {
  finalText: string;
  promptTokens: number;      // server-reported (authoritative)
  completionTokens: number;
  /** Char/4 estimates for requests the server reported no usage on. */
  estPromptTokens: number;
  estCompletionTokens: number;
  estCostUsd: number;
  requests: number;       // chatStream calls issued
  usageEvents: number;    // responses that reported token usage
  /** True when some request(s) returned no usage — server totals undercount, est fills the gap. */
  partialUsage: boolean;
  turns: number;          // assistant→tool round-trips
  toolCalls: number;
  costUsd: number;
  tiers: Record<string, number>;
  lastModel: string;
  elapsedMs: number;
  stoppedBy: "done" | "max_turns" | "max_cost" | "loop" | "error";
  error?: string;
}

export interface HeadlessOptions {
  tools?: ToolDefinition[];
  tier?: string;
  maxTurns?: number;
  /** Hard USD cap (9.4) — the loop stops with stoppedBy "max_cost" when
   * reported + estimated cost reaches it. Essential for CI/cron use. */
  maxCostUsd?: number;
  /** Wall-clock in ms from a monotonic clock the caller controls (test-safe). */
  now: () => number;
  /** Optional per-token / per-tool progress sink (bench prints a dot). */
  onProgress?: (ev: { kind: "token" | "tool" | "turn"; detail?: string }) => void;
}

const TIER_COST: Record<string, [number, number]> = {
  nano: [0.10, 0.20], fast: [0.25, 0.75], code: [0.50, 1.50],
  reason: [1.00, 3.00], heavy: [2.50, 8.00],
  flash: [0.25, 0.75], core: [0.60, 2.00], beast: [2.50, 8.00],
};

/** Run the agentic loop to completion. Never throws — errors land in the result. */
export async function runHeadlessAgent(
  client: KlaatAIClient,
  messages: Message[],
  projectRoot: string,
  opts: HeadlessOptions,
): Promise<HeadlessResult> {
  const tools = opts.tools ?? TOOL_DEFINITIONS;
  const maxTurns = opts.maxTurns ?? 40;
  const started = opts.now();

  const res: HeadlessResult = {
    finalText: "", promptTokens: 0, completionTokens: 0,
    estPromptTokens: 0, estCompletionTokens: 0, estCostUsd: 0, requests: 0,
    usageEvents: 0, partialUsage: false,
    turns: 0, toolCalls: 0, costUsd: 0, tiers: {}, lastModel: "Auto",
    elapsedMs: 0, stoppedBy: "done",
  };

  let apiMessages = [...messages];
  let loopRefusals = 0; // 9.4: consecutive doom-loop refusal rounds

  try {
    while (res.turns < maxTurns) {
      // 9.4: hard cost cap for unattended runs.
      if (opts.maxCostUsd && res.costUsd + res.estCostUsd >= opts.maxCostUsd) {
        res.stoppedBy = "max_cost";
        res.error = `cost cap $${opts.maxCostUsd} reached ($${(res.costUsd + res.estCostUsd).toFixed(4)} spent)`;
        res.partialUsage = res.usageEvents < res.requests;
        res.elapsedMs = opts.now() - started;
        return res;
      }
      if (apiMessages.length > 8) apiMessages = compactMessagesForApi(apiMessages);

      let fullText = "";
      let pendingToolCalls: ToolCall[] | null = null;
      let gotUsage = false;
      let loopSignal: { count: number; results_identical?: boolean } | null = null;
      res.requests += 1; // one chatStream call per loop iteration
      // ~4 chars/token — used ONLY to fill in requests where the server sent no
      // usage chunk (intermediate tool-turns often don't), so multi-turn runs
      // don't report zero tokens. Real usage always wins when present.
      const promptChars = JSON.stringify(apiMessages).length;

      for await (const chunk of client.chatStream(apiMessages, {
        tools: tools.length ? tools : undefined,
        tier: opts.tier,
      })) {
        if (chunk.type === "token" && chunk.text) {
          fullText += chunk.text;
          opts.onProgress?.({ kind: "token" });
        } else if (chunk.type === "tool_call") {
          pendingToolCalls = chunk.tool_calls ?? null;
        } else if (chunk.type === "metadata" && chunk.metadata && chunk.usage) {
          gotUsage = true;
          res.usageEvents += 1;
          res.promptTokens += chunk.usage.prompt_tokens;
          res.completionTokens += chunk.usage.completion_tokens;
          const tier = chunk.metadata.tier ?? "smart";
          res.tiers[tier] = (res.tiers[tier] ?? 0) + 1;
          res.lastModel = chunk.metadata.model ?? res.lastModel;
          const [inp, out] = TIER_COST[tier] ?? [0.5, 1.5];
          res.costUsd += (chunk.usage.prompt_tokens * inp + chunk.usage.completion_tokens * out) / 1_000_000;
          loopSignal = chunk.metadata.loop_signal ?? null;
        } else if (chunk.type === "error") {
          res.stoppedBy = "error";
          res.error = chunk.error;
          res.partialUsage = res.usageEvents < res.requests;
          res.elapsedMs = opts.now() - started;
          return res;
        }
      }

      // Server sent no usage for this request — estimate so totals aren't zero.
      if (!gotUsage) {
        const estPrompt = Math.ceil(promptChars / 4);
        const estCompletion = Math.ceil(fullText.length / 4);
        res.estPromptTokens += estPrompt;
        res.estCompletionTokens += estCompletion;
        const [inp, out] = TIER_COST[opts.tier ?? "code"] ?? [0.5, 1.5];
        res.estCostUsd += (estPrompt * inp + estCompletion * out) / 1_000_000;
      }

      const cleaned = fullText
        .replace(/<(?:thinking|reasoning)>[\s\S]*?<\/(?:thinking|reasoning)>/g, "")
        .trim();

      if (pendingToolCalls && pendingToolCalls.length) {
        res.turns += 1;
        opts.onProgress?.({ kind: "turn" });
        apiMessages = [...apiMessages, { role: "assistant", content: cleaned, tool_calls: pendingToolCalls }];

        // 9.4: doom-loop reaction — refuse identical repeated rounds, stop
        // entirely after 3 refusals (headless has no user to intervene).
        if (loopSignal?.results_identical) {
          loopRefusals++;
          if (loopRefusals >= 3) {
            res.stoppedBy = "loop";
            res.error = "doom loop: model repeated the same tool round despite recovery guidance";
            res.partialUsage = res.usageEvents < res.requests;
            res.elapsedMs = opts.now() - started;
            return res;
          }
          const guidance =
            `Refused: doom-loop detected — this exact tool round already ran ${loopSignal.count}+ times ` +
            `with identical results. Do NOT repeat it; change approach or finish with your best answer.`;
          for (const tc of pendingToolCalls) {
            apiMessages = [...apiMessages, { role: "tool", content: guidance, tool_call_id: tc.id }];
          }
          continue;
        }
        loopRefusals = 0;

        for (const tc of pendingToolCalls) {
          const out = await executeTools(tc, projectRoot, client);
          res.toolCalls += 1;
          opts.onProgress?.({ kind: "tool", detail: tc.function.name });
          apiMessages = [...apiMessages, { role: "tool", content: out.slice(0, 20_000), tool_call_id: tc.id }];
        }
        continue;
      }

      res.finalText = cleaned || fullText;
      res.partialUsage = res.usageEvents < res.requests;
      res.elapsedMs = opts.now() - started;
      return res;
    }

    res.stoppedBy = "max_turns";
    res.partialUsage = res.usageEvents < res.requests;
    res.elapsedMs = opts.now() - started;
    return res;
  } catch (err) {
    res.stoppedBy = "error";
    res.error = err instanceof Error ? err.message : String(err);
    res.elapsedMs = opts.now() - started;
    return res;
  }
}
