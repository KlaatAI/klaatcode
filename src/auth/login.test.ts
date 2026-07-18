import { afterEach, beforeEach, describe, expect, mock, test } from "bun:test";
import type { KlaatAIClient } from "../api/client.js";

// ── Mocks ──────────────────────────────────────────────────────────────────
//
// `runWhoami` pulls credentials + the API client via relative imports. We patch
// both modules with `mock.module` so the test can drive the three observable
// states (no token / reachable backend / unreachable backend) without touching
// the real filesystem or network.

type Creds = { accessToken?: string | null; email?: string | null; plan?: string | null };

let mockToken: string | null = null;
let mockCreds: Creds = {};
let pingImpl: () => Promise<{ status: string }>;

mock.module("../auth/credentials.js", () => ({
  getAuthToken: () => mockToken,
  loadCredentials: () => mockCreds,
  saveCredentials: () => {},
  clearCredentials: () => {},
}));

mock.module("../api/client.js", () => ({
  KlaatAIClient: class {
    constructor() {}
    async ping(): Promise<{ status: string }> { return pingImpl(); }
  },
}));

// Import after the mocks are registered so runWhoami picks them up.
const { runWhoami } = await import("../auth/login.js") as {
  runWhoami: (baseUrl: string, json?: boolean) => Promise<void>;
};

// ── Console capture ──────────────────────────────────────────────────────────

let stdout: string[] = [];
let stderr: string[] = [];
let origLog: typeof console.log;
let origErr: typeof console.error;

beforeEach(() => {
  mockToken = null;
  mockCreds = {};
  stdout = [];
  stderr = [];
  origLog = console.log;
  origErr = console.error;
  console.log = ((...args: unknown[]) => { stdout.push(args.map(String).join(" ")); }) as typeof console.log;
  console.error = ((...args: unknown[]) => { stderr.push(args.map(String).join(" ")); }) as typeof console.error;
});

afterEach(() => {
  console.log = origLog;
  console.error = origErr;
});

const jsonOut = () => stdout.join("\n");
const errOut = () => stderr.join("\n");

describe("runWhoami (json: false)", () => {
  test("unauthenticated → prints the colored sign-in hint on stdout", async () => {
    await runWhoami("http://127.0.0.1:8765", false);
    expect(stdout.some((l) => l.includes("Not signed in"))).toBe(true);
    expect(errOut()).toBe("");
  });

  test("authenticated + backend online → renders the full colored block", async () => {
    mockToken = "jwt-abc";
    mockCreds = { accessToken: "jwt-abc", email: "demo@klaatai.com", plan: "pro" };
    pingImpl = async () => ({ status: "ok" });
    await runWhoami("http://127.0.0.1:8765", false);
    const blob = jsonOut();
    expect(blob).toContain("demo@klaatai.com");
    expect(blob).toContain("pro");
    expect(blob).toContain("subscription (JWT)");
    expect(blob.toLowerCase()).toContain("online");
    expect(errOut()).toBe("");
  });

  test("authenticated but API unreachable → writes error to stderr", async () => {
    mockToken = "jwt-abc";
    mockCreds = { accessToken: "jwt-abc", email: "x@y.z", plan: "free" };
    pingImpl = async () => { throw new Error("fetch failed"); };
    await runWhoami("http://127.0.0.1:8765", false);
    expect(errOut()).toContain("Could not reach KlaatAI API");
    expect(jsonOut()).toBe("");
  });
});

describe("runWhoami (json: true)", () => {
  const parse = (s: string) => JSON.parse(s);

  test("unauthenticated → { signedIn:false, backend:unknown }", async () => {
    await runWhoami("http://127.0.0.1:8765", true);
    const obj = parse(jsonOut());
    expect(obj.signedIn).toBe(false);
    expect(obj.backend).toBe("unknown");
    expect(errOut()).toBe("");
  });

  test("authenticated + backend online → success schema with email/plan", async () => {
    mockToken = "jwt-abc";
    mockCreds = { accessToken: "jwt-abc", email: "demo@klaatai.com", plan: "pro" };
    pingImpl = async () => ({ status: "ok" });
    await runWhoami("http://127.0.0.1:8765", true);
    const obj = parse(jsonOut());
    expect(obj.signedIn).toBe(true);
    expect(obj.email).toBe("demo@klaatai.com");
    expect(obj.plan).toBe("pro");
    expect(obj.backend).toBe("online");
    expect(errOut()).toBe("");
  });

  test("authenticated + backend offline → online:false schema on stderr", async () => {
    mockToken = "jwt-abc";
    mockCreds = { accessToken: "jwt-abc", email: "x@y.z", plan: "free" };
    pingImpl = async () => { throw new Error("fetch failed"); };
    await runWhoami("http://127.0.0.1:8765", true);
    // Error path uses console.error so textual output stays on stderr while the
    // machine-readable JSON object is itself the stderr payload.
    const obj = parse(errOut());
    expect(obj.signedIn).toBe(true);
    expect(obj.email).toBeNull();
    expect(obj.plan).toBeNull();
    expect(obj.backend).toBe("offline");
    expect(jsonOut()).toBe("");
  });

  test("json mode never emits the colored banner / label lines", async () => {
    mockToken = "jwt-abc";
    mockCreds = { accessToken: "jwt-abc", email: "demo@klaatai.com", plan: "pro" };
    pingImpl = async () => ({ status: "ok" });
    await runWhoami("http://127.0.0.1:8765", true);
    const blob = jsonOut();
    expect(blob).not.toContain("Account:");
    expect(blob).not.toContain("Session:");
    // Must be valid JSON (no ANSI escapes / extra prose).
    expect(() => JSON.parse(blob)).not.toThrow();
  });
});

// Satisfy the unused-import linter when `KlaatAIClient` is referenced only as a
// type anchor for reviewers tracing the mock shape above.
export type _ClientShape = KlaatAIClient;
