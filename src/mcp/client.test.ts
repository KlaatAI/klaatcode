import { describe, expect, test } from "bun:test";
import { MCPServerClient, mcpRootsListResult } from "./client.js";

describe("mcpRootsListResult", () => {
  test("returns a file:// URI for the workspace root", () => {
    const result = mcpRootsListResult("/workspace/demo");
    expect(result.roots).toHaveLength(1);
    expect(result.roots[0]!.uri).toBe("file:///workspace/demo");
    expect(result.roots[0]!.name).toBe("demo");
  });
});

describe("MCPServerClient server-initiated requests", () => {
  test("_flush answers roots/list instead of dropping the request", () => {
    const written: string[] = [];
    const client = new MCPServerClient("test", { command: "true" });
    const priv = client as unknown as {
      _write: (msg: unknown) => void;
      _buffer: string;
      _flush: () => void;
    };
    priv._write = (msg: unknown) => written.push(JSON.stringify(msg));

    priv._buffer = `${JSON.stringify({
      jsonrpc: "2.0",
      id: 7,
      method: "roots/list",
    })}\n`;
    priv._flush();

    expect(written).toHaveLength(1);
    const resp = JSON.parse(written[0]!) as { id: number; result: ReturnType<typeof mcpRootsListResult> };
    expect(resp.id).toBe(7);
    expect(resp.result.roots[0]!.uri).toMatch(/^file:\/\//);
  });

  test("_flush still resolves pending client responses", () => {
    const client = new MCPServerClient("test", { command: "true" });
    const priv = client as unknown as {
      _pending: Map<number, { resolve: (v: unknown) => void; reject: (e: Error) => void; timer: ReturnType<typeof setTimeout> }>;
      _buffer: string;
      _flush: () => void;
    };

    let resolved: unknown;
    priv._pending.set(3, {
      resolve: (v) => { resolved = v; },
      reject: () => { throw new Error("unexpected reject"); },
      timer: setTimeout(() => {}, 60_000),
    });

    priv._buffer = `${JSON.stringify({
      jsonrpc: "2.0",
      id: 3,
      result: { tools: [] },
    })}\n`;
    priv._flush();

    expect(resolved).toEqual({ tools: [] });
    expect(priv._pending.has(3)).toBe(false);
  });

  test("_flush returns method-not-found for unknown server requests", () => {
    const written: string[] = [];
    const client = new MCPServerClient("test", { command: "true" });
    const priv = client as unknown as {
      _write: (msg: unknown) => void;
      _buffer: string;
      _flush: () => void;
    };
    priv._write = (msg: unknown) => written.push(JSON.stringify(msg));

    priv._buffer = `${JSON.stringify({
      jsonrpc: "2.0",
      id: 9,
      method: "sampling/createMessage",
    })}\n`;
    priv._flush();

    const resp = JSON.parse(written[0]!) as { id: number; error: { code: number } };
    expect(resp.id).toBe(9);
    expect(resp.error.code).toBe(-32601);
  });
});
