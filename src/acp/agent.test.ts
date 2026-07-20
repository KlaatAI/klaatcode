import { afterEach, beforeEach, describe, expect, mock, test } from "bun:test";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PassThrough } from "node:stream";
import type { StreamChunk } from "../api/client.js";
import * as realClient from "../api/client.js";
import * as realCredentials from "../auth/credentials.js";
import * as realPermissions from "../permissions/index.js";
import * as realLocalDb from "../tools/local-db.js";

// Real modules captured BEFORE mock.module — same reasoning as login.test.ts:
// bun's mock.module is process-global, so every mock here re-exports the real
// module and overrides only what a test needs to control.

let chatStreamImpl: (messages: unknown[]) => AsyncGenerator<StreamChunk>;

mock.module("../api/client.js", () => ({
  ...realClient,
  KlaatAIClient: class extends realClient.KlaatAIClient {
    constructor() { super({ baseUrl: "http://mock.invalid", apiKey: "test-token" }); }
    override async *chatStream(messages: unknown[]): AsyncGenerator<StreamChunk> {
      yield* chatStreamImpl(messages);
    }
  },
}));

mock.module("../auth/refresh.js", () => ({ getValidAuthToken: async () => "test-token" }));

// Snapshot the function reference BEFORE mock.module rewires the live import
// binding — calling `realCredentials.loadConfig()` from inside the factory
// below would resolve to the mock itself once registered (self-recursion,
// stack overflow on the very first call) rather than the real function.
const realLoadConfig = realCredentials.loadConfig;
mock.module("../auth/credentials.js", () => ({
  ...realCredentials,
  loadConfig: () => ({ ...realLoadConfig(), baseUrl: "http://mock.invalid" }),
}));

// Deterministic regardless of the host machine's real ~/.klaatai/permissions.json
// (a developer who'd previously clicked "always allow" on write_file in the real
// TUI would silently break the "unsafe tool" test below otherwise).
mock.module("../permissions/index.js", () => ({
  ...realPermissions,
  loadPermissions: () => ({ trusted_tools: [], allowed_commands: [], denied_commands: [] }),
}));

// No real network/db — indexing isn't what's under test here.
mock.module("../tools/kg-indexer.js", () => ({
  KGIndexer: class {
    constructor(_client: unknown) { void _client; }
    indexWorkspace(): Promise<void> { return Promise.resolve(); }
    onProgress(): () => void { return () => {}; }
  },
}));
// tools/index.ts (unmocked — we want real read_file/write_file execution)
// also imports from local-db.js, so this must spread the real exports too.
mock.module("../tools/local-db.js", () => ({ ...realLocalDb, initLocalDb: () => {} }));

const { AcpConnection } = await import("./connection.js");
const { AcpAgent } = await import("./agent.js");

function editorSide() {
  const agentOut  = new PassThrough(); // agent   -> editor
  const editorOut = new PassThrough(); // editor  -> agent
  const agentConn  = new AcpConnection(editorOut, agentOut);
  const editorConn = new AcpConnection(agentOut, editorOut);
  new AcpAgent(agentConn);
  return editorConn;
}

async function* textOnly(text: string): AsyncGenerator<StreamChunk> {
  for (const ch of text) yield { type: "token", text: ch };
  yield { type: "done" };
}

let projectRoot: string;
beforeEach(() => {
  projectRoot = mkdtempSync(join(tmpdir(), "klaatai-acp-"));
  chatStreamImpl = () => textOnly("");
});
afterEach(() => {
  rmSync(projectRoot, { recursive: true, force: true });
});

describe("AcpAgent — protocol handshake", () => {
  test("initialize negotiates protocol version 1 and reports capabilities", async () => {
    const editor = editorSide();
    const res = await editor.request("initialize", { protocolVersion: 1 }) as {
      protocolVersion: number; agentCapabilities: { loadSession: boolean }; agentInfo: { name: string };
    };
    expect(res.protocolVersion).toBe(1);
    expect(res.agentCapabilities.loadSession).toBe(false);
    expect(res.agentInfo.name).toBe("klaatcode");
  });

  test("session/new returns a fresh session id per call", async () => {
    const editor = editorSide();
    await editor.request("initialize", { protocolVersion: 1 });
    const a = await editor.request("session/new", { cwd: projectRoot, mcpServers: [] }) as { sessionId: string };
    const b = await editor.request("session/new", { cwd: projectRoot, mcpServers: [] }) as { sessionId: string };
    expect(a.sessionId).not.toBe(b.sessionId);
  });

  test("session/prompt against an unknown session id is rejected, not silently ignored", async () => {
    const editor = editorSide();
    await editor.request("initialize", { protocolVersion: 1 });
    await expect(editor.request("session/prompt", { sessionId: "nope", prompt: [] }))
      .rejects.toThrow(/Unknown session: nope/);
  });

  test("session/new before initialize is rejected, not silently ignored", async () => {
    const editor = editorSide();
    await expect(editor.request("session/new", { cwd: projectRoot, mcpServers: [] }))
      .rejects.toThrow(/initialize must be called first/);
  });
});

describe("AcpAgent — text turns", () => {
  test("streams agent_message_chunk per token and ends with end_turn", async () => {
    const editor = editorSide();
    const updates: Array<{ update: { sessionUpdate: string; content?: { text?: string } } }> = [];
    editor.onNotification("session/update", (p) => updates.push(p as typeof updates[number]));

    await editor.request("initialize", { protocolVersion: 1 });
    const { sessionId } = await editor.request("session/new", { cwd: projectRoot, mcpServers: [] }) as { sessionId: string };

    chatStreamImpl = () => textOnly("hi");
    const result = await editor.request("session/prompt", {
      sessionId, prompt: [{ type: "text", text: "hello" }],
    }) as { stopReason: string };

    expect(result.stopReason).toBe("end_turn");
    const chunks = updates.filter(u => u.update.sessionUpdate === "agent_message_chunk");
    expect(chunks.map(c => c.update.content?.text).join("")).toBe("hi");
  });
});

describe("AcpAgent — tool calls", () => {
  test("safe tool (read_file) executes without a permission round-trip", async () => {
    writeFileSync(join(projectRoot, "foo.txt"), "hello world");

    const editor = editorSide();
    const updates: Array<{ update: Record<string, unknown> }> = [];
    editor.onNotification("session/update", (p) => updates.push(p as typeof updates[number]));
    let permissionRequested = false;
    editor.onRequest("session/request_permission", async () => {
      permissionRequested = true;
      return { outcome: { outcome: "selected", optionId: "allow_once" } };
    });

    await editor.request("initialize", { protocolVersion: 1 });
    const { sessionId } = await editor.request("session/new", { cwd: projectRoot, mcpServers: [] }) as { sessionId: string };

    let call = 0;
    chatStreamImpl = async function* (): AsyncGenerator<StreamChunk> {
      call++;
      if (call === 1) {
        yield { type: "tool_call", tool_calls: [{ id: "t1", type: "function", function: { name: "read_file", arguments: JSON.stringify({ path: "foo.txt" }) } }] };
      } else {
        yield { type: "token", text: "done" };
      }
    };

    const result = await editor.request("session/prompt", { sessionId, prompt: [{ type: "text", text: "read foo.txt" }] }) as { stopReason: string };
    expect(result.stopReason).toBe("end_turn");
    expect(permissionRequested).toBe(false);

    const created = updates.find(u => u.update["sessionUpdate"] === "tool_call");
    expect(created?.update["kind"]).toBe("read");
    const completed = updates.find(u => u.update["sessionUpdate"] === "tool_call_update" && u.update["status"] === "completed");
    const content = completed?.update["content"] as Array<{ content?: { text?: string } }> | undefined;
    expect(content?.[0]?.content?.text).toContain("hello world");
  });

  test("unsafe tool (write_file) round-trips through session/request_permission", async () => {
    const editor = editorSide();
    const permissionCalls: Array<{ toolCall: { toolCallId: string } }> = [];
    editor.onRequest("session/request_permission", async (p) => {
      permissionCalls.push(p as typeof permissionCalls[number]);
      return { outcome: { outcome: "selected", optionId: "allow_once" } };
    });

    await editor.request("initialize", { protocolVersion: 1 });
    const { sessionId } = await editor.request("session/new", { cwd: projectRoot, mcpServers: [] }) as { sessionId: string };

    let call = 0;
    chatStreamImpl = async function* (): AsyncGenerator<StreamChunk> {
      call++;
      if (call === 1) {
        yield { type: "tool_call", tool_calls: [{ id: "t1", type: "function", function: { name: "write_file", arguments: JSON.stringify({ path: "new.txt", content: "hi there" }) } }] };
      } else {
        yield { type: "token", text: "wrote it" };
      }
    };

    const result = await editor.request("session/prompt", { sessionId, prompt: [{ type: "text", text: "create new.txt" }] }) as { stopReason: string };
    expect(result.stopReason).toBe("end_turn");
    expect(permissionCalls).toHaveLength(1);
    expect(permissionCalls[0]!.toolCall.toolCallId).toBe("t1");
    expect(readFileSync(join(projectRoot, "new.txt"), "utf-8")).toBe("hi there");
  });

  test("denied permission stops the tool and reports the denial back to the model", async () => {
    const editor = editorSide();
    editor.onRequest("session/request_permission", async () => ({ outcome: { outcome: "selected", optionId: "deny" } }));
    await editor.request("initialize", { protocolVersion: 1 });
    const { sessionId } = await editor.request("session/new", { cwd: projectRoot, mcpServers: [] }) as { sessionId: string };

    let call = 0;
    let toolResultSeen = "";
    chatStreamImpl = async function* (messages: unknown[]): AsyncGenerator<StreamChunk> {
      call++;
      if (call === 1) {
        yield { type: "tool_call", tool_calls: [{ id: "t1", type: "function", function: { name: "write_file", arguments: JSON.stringify({ path: "x.txt", content: "x" }) } }] };
      } else {
        const msgs = messages as Array<{ role: string; content: string }>;
        toolResultSeen = msgs.find(m => m.role === "tool")?.content ?? "";
        yield { type: "token", text: "ok" };
      }
    };
    await editor.request("session/prompt", { sessionId, prompt: [{ type: "text", text: "write x.txt" }] });
    expect(toolResultSeen).toContain("denied");
    expect(existsSync(join(projectRoot, "x.txt"))).toBe(false);
  });

  test("todo_write emits a plan update alongside its tool_call_update", async () => {
    const editor = editorSide();
    const updates: Array<{ update: Record<string, unknown> }> = [];
    editor.onNotification("session/update", (p) => updates.push(p as typeof updates[number]));

    await editor.request("initialize", { protocolVersion: 1 });
    const { sessionId } = await editor.request("session/new", { cwd: projectRoot, mcpServers: [] }) as { sessionId: string };

    let call = 0;
    chatStreamImpl = async function* (): AsyncGenerator<StreamChunk> {
      call++;
      if (call === 1) {
        yield {
          type: "tool_call", tool_calls: [{
            id: "t1", type: "function", function: {
              name: "todo_write",
              arguments: JSON.stringify({ todos: [{ id: "1", content: "Fix bug", status: "in_progress", priority: "high" }] }),
            },
          }],
        };
      } else {
        yield { type: "token", text: "ok" };
      }
    };

    await editor.request("session/prompt", { sessionId, prompt: [{ type: "text", text: "track this" }] });
    const plan = updates.find(u => u.update["sessionUpdate"] === "plan");
    expect(plan).toBeDefined();
    expect(plan?.update["entries"]).toEqual([{ content: "Fix bug", priority: "high", status: "in_progress" }]);
  });
});

describe("AcpAgent — cancellation", () => {
  test("session/cancel interrupts an in-flight turn mid-stream", async () => {
    const editor = editorSide();
    await editor.request("initialize", { protocolVersion: 1 });
    const { sessionId } = await editor.request("session/new", { cwd: projectRoot, mcpServers: [] }) as { sessionId: string };
    const updates: Array<{ update: { sessionUpdate: string; content?: { text?: string } } }> = [];
    editor.onNotification("session/update", (p) => updates.push(p as typeof updates[number]));

    chatStreamImpl = async function* (): AsyncGenerator<StreamChunk> {
      yield { type: "token", text: "before" };
      editor.notify("session/cancel", { sessionId }); // fires while sessionPrompt is mid-loop
      await new Promise(r => setTimeout(r, 10)); // let the notification reach the agent
      yield { type: "token", text: "after" };
    };

    const result = await editor.request("session/prompt", { sessionId, prompt: [{ type: "text", text: "go" }] }) as { stopReason: string };
    expect(result.stopReason).toBe("cancelled");
    const text = updates.filter(u => u.update.sessionUpdate === "agent_message_chunk").map(u => u.update.content?.text).join("");
    expect(text).toBe("before");
  });
});
