import { expect, test, beforeAll, afterAll } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { executeTools, configureSandbox } from "./index.js";
import type { ToolCall } from "../api/client.js";

// ─── multi_edit no-op tolerance ──────────────────────────────────────────────
// Seen live 2026-08-08: a 12-edit batch died because edit 1/12 had identical
// old/new strings, throwing away 11 valid edits and stalling the turn. An
// identical sub-edit is a redundancy (the file already reads as intended
// there), not a conflict — it must be skipped, not fatal.

let root: string;

beforeAll(() => {
  root = mkdtempSync(join(tmpdir(), "klaatai-multi-edit-"));
  configureSandbox({ enabled: true, root, allow: [] });
});

afterAll(() => {
  rmSync(root, { recursive: true, force: true });
});

function multiEditCall(path: string, edits: { old_string: string; new_string: string }[]): ToolCall {
  return {
    id: "m1",
    type: "function",
    function: { name: "multi_edit", arguments: JSON.stringify({ path, edits }) },
  } as ToolCall;
}

async function readTool(path: string): Promise<string> {
  return executeTools({
    id: "r1", type: "function",
    function: { name: "read_file", arguments: JSON.stringify({ path }) },
  } as ToolCall, root);
}

test("multi_edit: identical sub-edit is skipped, remaining edits apply", async () => {
  writeFileSync(join(root, "game.js"), "const GRAVITY = 0.45;\nconst LIVES = 3;\nconst SPEED = 2;\n");
  await readTool("game.js");

  const res = await executeTools(multiEditCall("game.js", [
    { old_string: "const GRAVITY = 0.45;", new_string: "const GRAVITY = 0.45;" }, // no-op
    { old_string: "const LIVES = 3;", new_string: "const LIVES = 5;" },
    { old_string: "const SPEED = 2;", new_string: "const SPEED = 4;" },
  ]), root);

  expect(res).toStartWith("OK:");
  expect(res).toContain("Applied 2 edits");
  expect(res).toContain("1 no-op edit skipped");
  const content = readFileSync(join(root, "game.js"), "utf-8");
  expect(content).toContain("const LIVES = 5;");
  expect(content).toContain("const SPEED = 4;");
  expect(content).toContain("const GRAVITY = 0.45;");
});

test("multi_edit: all no-ops reports success without writing", async () => {
  writeFileSync(join(root, "same.js"), "const A = 1;\n");
  await readTool("same.js");

  const res = await executeTools(multiEditCall("same.js", [
    { old_string: "const A = 1;", new_string: "const A = 1;" },
  ]), root);

  expect(res).toStartWith("OK: No changes needed");
});

test("multi_edit: a real mismatch still aborts the whole batch", async () => {
  writeFileSync(join(root, "strict.js"), "const B = 1;\n");
  await readTool("strict.js");

  const res = await executeTools(multiEditCall("strict.js", [
    { old_string: "const B = 1;", new_string: "const B = 2;" },
    { old_string: "const MISSING = 9;", new_string: "const MISSING = 10;" },
  ]), root);

  expect(res).toStartWith("Error:");
  expect(res).toContain("No changes were written");
  expect(readFileSync(join(root, "strict.js"), "utf-8")).toBe("const B = 1;\n");
});
