/** Detect tool results that represent a failure (built-in or MCP). */
export function isToolFailure(result: string): boolean {
  if (result.startsWith("Refused:")) return false;
  if (result.startsWith("Error") || result.startsWith("MCP tool error")) return true;
  const exitMatch = result.match(/^\[exit (\d+)\]/);
  return exitMatch !== null && exitMatch[1] !== "0";
}

/** Injected after a failed tool round so the model stays on the user's request. */
export const TOOL_FAILURE_FOCUS_HINT =
  "Previous tool call(s) failed. Stay focused on the user's original request — retry with corrected input, ask the user with ask_user if unclear, or explain what blocked you. Do NOT pivot to unrelated tools or tasks.";
