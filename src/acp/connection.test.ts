import { describe, expect, test } from "bun:test";
import { PassThrough } from "node:stream";
import { AcpConnection } from "./connection.js";

/** Two connections wired stdin↔stdout so both directions are exercised for real. */
function pair(): { a: AcpConnection; b: AcpConnection } {
  const aToB = new PassThrough();
  const bToA = new PassThrough();
  return { a: new AcpConnection(bToA, aToB), b: new AcpConnection(aToB, bToA) };
}

describe("AcpConnection", () => {
  test("request/response round-trip", async () => {
    const { a, b } = pair();
    b.onRequest("ping", async (params) => ({ pong: params }));
    const result = await a.request("ping", { n: 1 });
    expect(result).toEqual({ pong: { n: 1 } });
  });

  test("notifications carry no id and expect no response", async () => {
    const { a, b } = pair();
    const received: unknown[] = [];
    b.onNotification("event", (p) => received.push(p));
    a.notify("event", { x: "y" });
    await new Promise(r => setTimeout(r, 10));
    expect(received).toEqual([{ x: "y" }]);
  });

  test("unknown method returns a JSON-RPC error, not a hang", async () => {
    const { a, b } = pair();
    void b; // b has no handlers registered
    await expect(a.request("nope", {})).rejects.toThrow(/Method not found: nope/);
  });

  test("handler throwing surfaces as a rejected request, not a crash", async () => {
    const { a, b } = pair();
    b.onRequest("boom", async () => { throw new Error("kaboom"); });
    await expect(a.request("boom", {})).rejects.toThrow(/kaboom/);
  });

  test("either side can call the other (bidirectional)", async () => {
    const { a, b } = pair();
    a.onRequest("fromB", async () => "handled-by-a");
    b.onRequest("fromA", async () => "handled-by-b");
    expect(await a.request("fromA", {})).toBe("handled-by-b");
    expect(await b.request("fromB", {})).toBe("handled-by-a");
  });

  test("malformed JSON lines are skipped, not fatal", async () => {
    const aToB = new PassThrough();
    const bToA = new PassThrough();
    const a = new AcpConnection(bToA, aToB);
    new AcpConnection(aToB, bToA).onRequest("ping", async () => "pong");

    aToB.write("not json at all\n"); // injected directly, ahead of any real request
    const result = await a.request("ping", {});
    expect(result).toBe("pong");
  });
});
