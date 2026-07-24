import { expect, test } from "bun:test";
import type { Message, ToolDefinition } from "../api/client.js";
import { CORE_SYSTEM_PROMPT } from "./system-prompt.js";
import {
  classifySystemBucket,
  computeContextBreakdown,
  formatContextBar,
} from "./context-breakdown.js";

test("classifySystemBucket: core, environment, project rules, mode", () => {
  expect(classifySystemBucket(CORE_SYSTEM_PROMPT)).toBe("core");
  expect(classifySystemBucket("# Environment\nWorking directory: /tmp")).toBe("environment");
  expect(classifySystemBucket("# Project rules (from AGENTS.md)\n\nBe nice.")).toBe("projectRules");
  expect(classifySystemBucket("# Mode: Build\nImplement directly.")).toBe("mode");
  expect(classifySystemBucket("custom system note")).toBe("other");
});

test("computeContextBreakdown: splits system vs conversation and tool schemas", () => {
  const msgs: Message[] = [
    { role: "system", content: CORE_SYSTEM_PROMPT },
    { role: "system", content: "# Environment\nWorking directory: /proj" },
    { role: "user", content: "hello" },
    { role: "assistant", content: "hi there" },
    { role: "tool", content: "file contents here" },
  ];
  const tools: ToolDefinition[] = [{
    type: "function",
    function: { name: "read_file", description: "Read a file", parameters: { type: "object", properties: {} } },
  }];

  const b = computeContextBreakdown(msgs, tools);
  expect(b.system.core).toBeGreaterThan(0);
  expect(b.system.environment).toBeGreaterThan(0);
  expect(b.conversation.userMsgs).toBe(1);
  expect(b.conversation.assistantMsgs).toBe(1);
  expect(b.conversation.toolMsgs).toBe(1);
  expect(b.toolCount).toBe(1);
  expect(b.toolSchemas).toBeGreaterThan(0);
  expect(b.estimatedTotal).toBe(b.messagesTotal + b.toolSchemas);
});

test("computeContextBreakdown: detects trimmed and compacted markers", () => {
  const msgs: Message[] = [
    { role: "assistant", content: "[Context compacted — earlier turns summarized]" },
    { role: "tool", content: "partial\n[… 500 chars trimmed — grep]" },
  ];
  const b = computeContextBreakdown(msgs);
  expect(b.compactedStub).toBe(true);
  expect(b.trimmedToolResults).toBe(1);
});

test("computeContextBreakdown: counts assistant tool_calls tokens", () => {
  const msgs: Message[] = [{
    role: "assistant",
    content: "",
    tool_calls: [{
      id: "tc1",
      type: "function",
      function: { name: "read_file", arguments: JSON.stringify({ path: "src/main.ts" }) },
    }],
  }];
  const b = computeContextBreakdown(msgs);
  expect(b.conversation.assistant).toBeGreaterThan(0);
});

test("classifySystemBucket: /init-style project rules", () => {
  expect(classifySystemBucket("Project rules (from .klaatai/rules.md):\n\nUse tabs.")).toBe("projectRules");
});

test("computeContextBreakdown: estimatedTotal equals sum of parts", () => {
  const msgs: Message[] = [
    { role: "system", content: CORE_SYSTEM_PROMPT },
    { role: "user", content: "hi" },
  ];
  const tools: ToolDefinition[] = [{
    type: "function",
    function: { name: "grep", description: "search", parameters: { type: "object", properties: {} } },
  }];
  const b = computeContextBreakdown(msgs, tools);
  expect(b.estimatedTotal).toBe(b.messagesTotal + b.toolSchemas);
});

test("formatContextBar: clamps and fills proportionally", () => {
  expect(formatContextBar(0, 10)).toBe("░░░░░░░░░░");
  expect(formatContextBar(100, 10)).toBe("██████████");
  expect(formatContextBar(50, 10)).toBe("█████░░░░░");
});
