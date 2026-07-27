/**
 * Context-window breakdown — single source of truth for token estimates.
 *
 * Uses the same chars÷4 heuristic as compaction.ts so /context, compaction
 * budgets, and sidebar displays stay consistent.
 */

import type { Message, ToolDefinition } from "../api/client.js";
import { CORE_SYSTEM_PROMPT, MODE_PROMPTS } from "./system-prompt.js";
import { estimateTokensFromText, estimateTokensFromChars } from "./compaction.js";

export interface SystemTokenBreakdown {
  core: number;
  environment: number;
  projectRules: number;
  mode: number;
  other: number;
  total: number;
}

export interface ConversationTokenBreakdown {
  user: number;
  assistant: number;
  tool: number;
  userMsgs: number;
  assistantMsgs: number;
  toolMsgs: number;
  total: number;
}

export interface ContextBreakdown {
  system: SystemTokenBreakdown;
  conversation: ConversationTokenBreakdown;
  toolSchemas: number;
  toolCount: number;
  messagesTotal: number;
  estimatedTotal: number;
  trimmedToolResults: number;
  compactedStub: boolean;
}

const MODE_PROMPT_VALUES = new Set(Object.values(MODE_PROMPTS));

function messageChars(m: Message): number {
  let chars = 0;
  if (typeof m.content === "string") chars += m.content.length;
  else if (Array.isArray(m.content)) {
    for (const p of m.content) {
      if (p.type === "text") chars += p.text?.length ?? 0;
    }
  }
  if (m.tool_calls?.length) chars += JSON.stringify(m.tool_calls).length;
  return chars;
}

function messageTokens(m: Message): number {
  return estimateTokensFromChars(messageChars(m));
}

export function classifySystemBucket(content: string): keyof Omit<SystemTokenBreakdown, "total"> {
  if (content === CORE_SYSTEM_PROMPT || content.startsWith("You are Klaat Code")) return "core";
  if (content.startsWith("# Environment")) return "environment";
  if (content.startsWith("# Project rules") || content.startsWith("Project rules (from")) return "projectRules";
  if (MODE_PROMPT_VALUES.has(content) || content.startsWith("# Mode:")) return "mode";
  return "other";
}

export function computeContextBreakdown(
  msgs: Message[],
  tools: ToolDefinition[] = [],
): ContextBreakdown {
  const system: SystemTokenBreakdown = {
    core: 0, environment: 0, projectRules: 0, mode: 0, other: 0, total: 0,
  };
  const conversation: ConversationTokenBreakdown = {
    user: 0, assistant: 0, tool: 0,
    userMsgs: 0, assistantMsgs: 0, toolMsgs: 0,
    total: 0,
  };

  let trimmedToolResults = 0;
  let compactedStub = false;

  for (const m of msgs) {
    const toks = messageTokens(m);
    const text = typeof m.content === "string" ? m.content : "";

    if (m.role === "system") {
      const bucket = classifySystemBucket(text);
      system[bucket] += toks;
      system.total += toks;
    } else if (m.role === "user") {
      conversation.user += toks;
      conversation.userMsgs++;
      conversation.total += toks;
    } else if (m.role === "assistant") {
      conversation.assistant += toks;
      conversation.assistantMsgs++;
      conversation.total += toks;
      if (text.startsWith("[Context compacted")) compactedStub = true;
    } else if (m.role === "tool") {
      conversation.tool += toks;
      conversation.toolMsgs++;
      conversation.total += toks;
      if (text.includes("chars trimmed")) trimmedToolResults++;
    }
  }

  const toolSchemas = tools.length > 0
    ? estimateTokensFromText(JSON.stringify(tools))
    : 0;

  return {
    system,
    conversation,
    toolSchemas,
    toolCount: tools.length,
    messagesTotal: system.total + conversation.total,
    estimatedTotal: system.total + conversation.total + toolSchemas,
    trimmedToolResults,
    compactedStub,
  };
}

/** ASCII progress bar for transcript output (█ filled, ░ empty). */
export function formatContextBar(pct: number, width = 20): string {
  const clamped = Math.min(100, Math.max(0, Math.round(pct)));
  const filled = Math.round((clamped / 100) * width);
  return "█".repeat(filled) + "░".repeat(width - filled);
}

export function formatBreakdownLine(label: string, tokens: number, extra = ""): string {
  const pad = label.padEnd(16);
  const suffix = extra ? `  ${extra}` : "";
  return `    ${pad} ${formatTokInline(tokens)}${suffix}`;
}

function formatTokInline(n: number): string {
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(1)}M toks`;
  if (n >= 1_000) return `${(n / 1_000).toFixed(1)}K toks`;
  return `${n} toks`;
}
