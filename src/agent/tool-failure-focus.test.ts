import { expect, test } from "bun:test";
import { isToolFailure, TOOL_FAILURE_FOCUS_HINT } from "./tool-failure-focus.js";

test("isToolFailure: built-in Error prefix", () => {
  expect(isToolFailure("Error: File not found: foo.ts")).toBe(true);
});

test("isToolFailure: MCP tool error prefix", () => {
  expect(isToolFailure("MCP tool error (browser/navigate): 404 Not Found")).toBe(true);
});

test("isToolFailure: success results", () => {
  expect(isToolFailure("Wrote 42 bytes to src/foo.ts")).toBe(false);
  expect(isToolFailure("[exit 0]\nok")).toBe(false);
});

test("isToolFailure: permission and MCP transport errors", () => {
  expect(isToolFailure("Error: User denied permission for this tool call.")).toBe(true);
  expect(isToolFailure('Error: MCP server "browser" is not connected (status: error)')).toBe(true);
  expect(isToolFailure('Error calling MCP tool "browser/navigate": timeout')).toBe(true);
});

test("isToolFailure: run_command non-zero exit", () => {
  expect(isToolFailure("[exit 1]\ncommand failed")).toBe(true);
  expect(isToolFailure("[exit 0]\nok")).toBe(false);
});

test("isToolFailure: doom-loop refusal is not a failure", () => {
  expect(isToolFailure("Refused: doom-loop detected — change approach.")).toBe(false);
});

test("TOOL_FAILURE_FOCUS_HINT mentions staying focused", () => {
  expect(TOOL_FAILURE_FOCUS_HINT).toContain("Stay focused");
  expect(TOOL_FAILURE_FOCUS_HINT).toContain("ask_user");
});
