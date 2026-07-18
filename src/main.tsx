#!/usr/bin/env bun
/**
 * KlaatAI CLI entrypoint.
 *
 * Default flow (klaatai / klaatai chat):
 *   1. Create App (TUI engine)
 *   2. Show branded Splash screen while booting
 *   3. Check stored credentials
 *   4. If none → open browser for login (localhost callback flow)
 *   5. Transition to Welcome screen (Enter-gated)
 *   6. Transition to interactive REPL
 *
 * Named commands:
 *   klaatai login    — authenticate via browser or API key flag
 *   klaatai logout   — clear stored credentials
 *   klaatai whoami   — show current user + backend status
 */

import { Command } from "commander";
import { App, detectTheme, getPalette, THEME_NAMES, type Theme } from "./engine/index.js";
import { KlaatAIClient, type Message } from "./api/client.js";
import { runLogout, runWhoami } from "./auth/login.js";
import { loadConfig, saveCredentials, loadCredentials } from "./auth/credentials.js";
import { getValidAuthToken, forceRefreshToken } from "./auth/refresh.js";
import { startOAuthBrowserAuth } from "./auth/browser.js";
import { runSplash } from "./screens/splash.js";
import { runREPL } from "./screens/repl.js";
import { readFileSync, existsSync, statSync, readdirSync } from "node:fs";
import { join, resolve } from "node:path";
import { homedir } from "node:os";
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { spawnSync as _openBrowser } from "node:child_process";
import { version as VERSION } from "../package.json";
import { loadProjectRules } from "./agent/system-prompt.js";

// ─── Helpers ─────────────────────────────────────────────────────────────────

const sleep = (ms: number): Promise<void> =>
  new Promise((resolve) => setTimeout(resolve, ms));

// TLS: corporate MITM proxies present a cert chain Bun's bundled CA store
// rejects even though the OS trusts it. `insecureTls: true` in config (or the
// env var itself) disables verification; NODE_EXTRA_CA_CERTS is the safer fix.
if (loadConfig().insecureTls && !process.env["NODE_TLS_REJECT_UNAUTHORIZED"]) {
  process.env["NODE_TLS_REJECT_UNAUTHORIZED"] = "0";
  process.stderr.write("Warning: TLS certificate verification disabled (config.insecureTls).\n");
}

/**
 * The browser-login page lives on the web app, not the API host:
 * dev API (127.0.0.1) → localhost web; api.klaatai.com → klaatai.com.
 */
function deriveWebUrl(baseUrl: string): string {
  if (baseUrl.includes("127.0.0.1") || baseUrl.includes("localhost")) {
    return "http://localhost:4410";
  }
  if (baseUrl.includes("api.klaatai.com")) return "https://klaatai.com";
  return baseUrl;
}

/**
 * Pre-boot session picker: full-screen interactive list with search.
 * Shown when user runs `klaatcode -r` without an ID.
 * Returns the selected session ID or null to start fresh.
 */
async function runSessionPicker(): Promise<string | null> {
  const SESSION_DIR = join(homedir(), ".klaatai", "sessions");
  let sessions: { id: string; date: string; preview: string }[] = [];
  try {
    sessions = readdirSync(SESSION_DIR)
      .filter(f => f.endsWith(".jsonl"))
      .sort().reverse().slice(0, 50)
      .map(f => {
        const id = f.replace(".jsonl", "");
        try {
          const lines = readFileSync(join(SESSION_DIR, f), "utf-8").trim().split("\n").filter(Boolean);
          const firstUser = lines.map(l => JSON.parse(l)).find((m: any) => m.role === "user");
          const preview = ((firstUser?.content as string) ?? "(empty)").slice(0, 80);
          const date = id.slice(0, 16).replace("T", " ").replace(/-/g, (m, i) => i < 10 ? "-" : ":");
          return { id, date, preview };
        } catch {
          return { id, date: id.slice(0, 16), preview: "(unreadable)" };
        }
      });
  } catch { /* no sessions dir */ }

  if (sessions.length === 0) {
    process.stdout.write("\x1b[2mNo saved sessions found. Starting fresh.\x1b[0m\n");
    return null;
  }

  // Enter raw mode for interactive selection
  const { stdin, stdout } = process;
  stdin.setRawMode(true);
  stdin.resume();
  stdin.setEncoding("utf-8");

  let cursor = 0;
  let search = "";
  let filtered = sessions;

  function filterSessions(): void {
    if (!search) { filtered = sessions; return; }
    const q = search.toLowerCase();
    filtered = sessions.filter(s => s.preview.toLowerCase().includes(q) || s.id.includes(q) || s.date.includes(q));
  }

  function render(): void {
    stdout.write("\x1b[2J\x1b[H"); // clear screen, cursor to top
    const dim = "\x1b[2m";
    const reset = "\x1b[0m";
    const bold = "\x1b[1m";
    const cyan = "\x1b[36m";
    const accent = "\x1b[38;5;141m";
    const white = "\x1b[37m";

    stdout.write(`${accent}${bold}  ⏵ Resume Session${reset}\n`);
    stdout.write(`${dim}  ─────────────────────────────────────────${reset}\n`);
    stdout.write(`  ${cyan}Search:${reset} ${search}${dim}│${reset}\n`);
    stdout.write(`${dim}  ─────────────────────────────────────────${reset}\n\n`);

    const rows = Math.min(filtered.length, (process.stdout.rows || 24) - 8);
    const start = Math.max(0, cursor - rows + 3);
    for (let i = start; i < start + rows && i < filtered.length; i++) {
      const s = filtered[i]!;
      const isFocused = i === cursor;
      const marker = isFocused ? `${accent}❯${reset}` : " ";
      const datePart = s.date.slice(5, 16);
      const previewPart = s.preview.slice(0, (process.stdout.columns || 80) - 25);
      if (isFocused) {
        stdout.write(`  ${marker} ${bold}${white}${datePart}${reset}  ${previewPart}\n`);
      } else {
        stdout.write(`  ${marker} ${dim}${datePart}${reset}  ${dim}${previewPart}${reset}\n`);
      }
    }

    stdout.write(`\n${dim}  ↑↓ navigate · enter select · esc start fresh · type to search${reset}\n`);
  }

  render();

  return new Promise<string | null>((resolveP) => {
    function cleanup(): void {
      stdin.setRawMode(false);
      stdin.pause();
      stdout.write("\x1b[2J\x1b[H"); // clear screen
    }

    stdin.on("data", (key: string) => {
      if (key === "\x1b" || key === "\x03") {
        // Escape or Ctrl+C — start fresh
        cleanup();
        resolveP(null);
        return;
      }
      if (key === "\r" || key === "\n") {
        // Enter — select
        cleanup();
        resolveP(filtered[cursor]?.id ?? null);
        return;
      }
      if (key === "\x1b[A") {
        // Up arrow
        cursor = Math.max(0, cursor - 1);
        render();
        return;
      }
      if (key === "\x1b[B") {
        // Down arrow
        cursor = Math.min(filtered.length - 1, cursor + 1);
        render();
        return;
      }
      if (key === "\x7f" || key === "\b") {
        // Backspace
        search = search.slice(0, -1);
        filterSessions();
        cursor = 0;
        render();
        return;
      }
      // Printable character — add to search
      if (key.length === 1 && key.charCodeAt(0) >= 32) {
        search += key;
        filterSessions();
        cursor = 0;
        render();
      }
    });
  });
}

/**
 * Full boot sequence: Splash → auth (if needed) → Welcome → REPL.
 */
async function boot(opts: { baseUrl?: string; dir?: string; resumeId?: string } = {}): Promise<void> {
  // ── Session picker (runs before TUI when `klaatcode -r` with no ID) ───────
  if (opts.resumeId === "pick") {
    const picked = await runSessionPicker();
    opts.resumeId = picked ?? undefined; // null = start fresh, string = resume that ID
  }

  // ── Resolve project root ───────────────────────────────────────────────────
  if (opts.dir) {
    const resolved = resolve(opts.dir);
    if (!existsSync(resolved) || !statSync(resolved).isDirectory()) {
      process.stderr.write(`Error: "${opts.dir}" is not a valid directory.\n`);
      process.exit(1);
    }
    process.chdir(resolved);
  }

  const config      = loadConfig();
  const baseUrl     = opts.baseUrl ?? config.baseUrl;
  const projectRoot = process.cwd();
  const webUrl      = deriveWebUrl(baseUrl);

  // ── 1. Detect terminal color theme (before entering alt-screen) ───────────
  const detectedTheme = await detectTheme();
  const theme: Theme = (THEME_NAMES as string[]).includes(config.theme ?? "")
    ? (config.theme as Theme)
    : detectedTheme;

  // ── 2. Create TUI engine + start event loop ────────────────────────────────
  const app = new App();

  // Handle Ctrl+C at the top level (REPL handles its own; this is a safety net)
  app.onKey("ctrl+c", () => app.quit());

  // Start the event loop. The splash/welcome/REPL screens take turns calling
  // app.setRenderFn() to own the display. The loop runs until app.quit().
  const appDone = app.run(() => { /* initial empty render — splash mounts next tick */ });

  // ── 2. Show Splash ─────────────────────────────────────────────────────────
  const splash = await runSplash(app, { status: "Initializing…", projectPath: projectRoot, accent: getPalette(theme).accent });
  await sleep(300);

  // ── 3. Resolve API key ─────────────────────────────────────────────────────
  splash.setSplashStatus("Checking credentials…");
  let apiKey: string | null =
    process.env["KLAATAI_API_KEY"] ??
    await getValidAuthToken();

  if (apiKey) {
    splash.setSplashStatus("Connecting to KlaatAI…");
    const pingClient = new KlaatAIClient({ apiKey, baseUrl });
    let connected = false;
    for (let attempt = 1; attempt <= 3; attempt++) {
      try {
        await pingClient.ping(8_000);
        connected = true;
        break;
      } catch {
        if (attempt < 3) {
          splash.setSplashStatus(`Retrying connection… (${attempt}/3)`);
          await sleep(1500);
        }
      }
    }
    if (connected) {
      splash.setSplashStatus("Connected — loading workspace…");
      await sleep(600);
    } else {
      splash.setSplashStatus("Could not reach KlaatAI. Check your internet and try again.");
      await sleep(3000);
      splash.unmount();
      app.quit();
      await appDone;
      process.exit(1);
    }
  } else {
    // ── 4. Browser auth: OAuth (subscription JWT) only. ───────────────────────
    splash.setSplashStatus("Opening browser to sign in…");
    await sleep(600);

    const oauthCreds = await startOAuthBrowserAuth(webUrl, baseUrl, splash.setSplashStatus, 120_000);
    if (oauthCreds?.accessToken) {
      saveCredentials(oauthCreds); // full overwrite — clears any legacy key
      apiKey = oauthCreds.accessToken;
    }

    if (!apiKey) {
      splash.setSplashStatus("Sign-in timed out or was cancelled. Run klaatai again to retry.");
      await sleep(3000);
      splash.unmount();
      app.quit();
      await appDone;
      process.exit(1);
    }

    splash.setSplashStatus("Signed in — loading workspace…");
    await sleep(600);
  }

  splash.unmount();

  // ── 5. Full-screen REPL (welcome banner now lives in the transcript) ────────
  // Token recovery: on 401 → silent refresh first; if dead → browser re-login.
  // During browser re-auth we temporarily leave alt-screen so the user can see
  // the login URL and interact with the browser, then restore the TUI.
  const onAuthExpired = async (): Promise<string | null> => {
    // 1) Force-refresh via Supabase (the current token was already rejected)
    const refreshed = await forceRefreshToken();
    if (refreshed) {
      apiKey = refreshed;
      return refreshed;
    }

    // 2) Refresh token is dead — need full browser re-login.
    //    Leave alt-screen so the terminal shows the login URL.
    process.stdout.write("\x1b[?1049l"); // exit alt-screen
    process.stdout.write("\x1b[?25h");   // show cursor
    process.stdout.write("\n\x1b[33m⚠ Session expired — opening browser to re-authenticate…\x1b[0m\n\n");

    const creds = await startOAuthBrowserAuth(webUrl, baseUrl, (msg) => {
      process.stdout.write(`  ${msg}\n`);
    }, 120_000);

    // Restore alt-screen regardless of outcome
    process.stdout.write("\x1b[?1049h"); // enter alt-screen
    process.stdout.write("\x1b[?25l");   // hide cursor
    app.requestRender();

    if (creds?.accessToken) {
      saveCredentials(creds);
      apiKey = creds.accessToken;
      return creds.accessToken;
    }
    return null;
  };

  const client = new KlaatAIClient({ apiKey, baseUrl, onAuthExpired });
  const sessionResult = await runREPL(app, client, { ...config, baseUrl }, projectRoot, { theme, resumeId: opts.resumeId });

  // REPL finished — clean up
  app.quit();
  await appDone;

  // Print session resume hint after TUI exits
  if (sessionResult?.sessionId) {
    const dim = "\x1b[2m";
    const bold = "\x1b[1m";
    const cyan = "\x1b[36m";
    const reset = "\x1b[0m";
    process.stdout.write(`\n${dim}Session saved. Resume with:${reset}\n`);
    process.stdout.write(`  ${bold}${cyan}klaatcode --resume ${sessionResult.sessionId}${reset}\n\n`);
  }
}

// ─── Commands ─────────────────────────────────────────────────────────────────

const program = new Command();

program
  .name("klaatai")
  .description("KlaatAI CLI — AI coding assistant with smart model routing")
  .version(VERSION, "-v, --version", "Print version and exit");

// ── klaatai chat (default) ────────────────────────────────────────────────────

program
  .command("chat", { isDefault: true })
  .description("Start interactive AI chat (default command)")
  .argument("[dir]", "Project directory to open (defaults to current directory)")
  .option("--base-url <url>", "API base URL override")
  .option("-r, --resume [id]", "Resume a previous session (shows picker if no id)")
  .option("--continue", "Alias for --resume (resume last session)")
  .action(async (dir: string | undefined, opts: { baseUrl?: string; resume?: string | boolean; continue?: boolean }) => {
    const resumeId = opts.continue ? "last" :
      opts.resume === true ? "pick" :
      (typeof opts.resume === "string" ? opts.resume : undefined);
    await boot({ ...opts, dir, resumeId });
  });

// ── klaatai run (non-interactive / headless) ──────────────────────────────────

/**
 * Headless execution: send a single prompt to the API and stream the response
 * to stdout. No TUI. Suitable for piping, CI, scripts.
 *
 *   klaatai run "Fix the TODO in main.ts"
 *   klaatai run --model fast "Summarise this file" < file.ts
 *   echo "Explain this" | klaatai run -
 */
async function runHeadless(opts: {
  prompt: string;
  baseUrl?: string;
  model?: string;
  system?: string;
}): Promise<void> {
  const config  = loadConfig();
  const baseUrl = opts.baseUrl ?? config.baseUrl;
  // Subscription JWT (or KLAATAI_API_KEY env override for CI/headless).
  const apiKey  = process.env["KLAATAI_API_KEY"] ?? await getValidAuthToken();

  if (!apiKey) {
    process.stderr.write("Not signed in. Run: klaatai login\n");
    process.exit(1);
  }

  const client = new KlaatAIClient({ apiKey, baseUrl });
  const projectRoot = process.cwd();

  // Build messages — include project rules if present
  const messages: Message[] = [];
  const rules = loadProjectRules(projectRoot);
  if (rules) messages.push({ role: "system", content: rules });
  if (opts.system) {
    messages.push({ role: "system", content: opts.system });
  }
  messages.push({ role: "user", content: opts.prompt });

  try {
    for await (const chunk of client.chatStream(messages, { tier: opts.model })) {
      if (chunk.type === "token" && chunk.text) {
        process.stdout.write(chunk.text);
      } else if (chunk.type === "error") {
        process.stderr.write(`\nError: ${chunk.error}\n`);
        process.exit(1);
      }
    }
    process.stdout.write("\n");
  } catch (err) {
    process.stderr.write(`\nError: ${err instanceof Error ? err.message : String(err)}\n`);
    process.exit(1);
  }
}

program
  .command("run [prompt]")
  .description("Run a single prompt non-interactively and stream output to stdout")
  .option("--base-url <url>", "API base URL override")
  .option("--model <tier>", "Force routing tier (nano/fast/code/reason/heavy)")
  .option("--system <text>", "Prepend a system message before the prompt")
  .action(async (promptArg: string | undefined, opts: {
    baseUrl?: string; model?: string; system?: string;
  }) => {
    // Support piped stdin: klaatai run - (or klaatai run with stdin piped)
    let prompt = promptArg;
    if (!prompt || prompt === "-") {
      // Read from stdin if available (non-TTY pipe)
      if (!process.stdin.isTTY) {
        const chunks: Buffer[] = [];
        for await (const chunk of process.stdin) chunks.push(chunk as Buffer);
        prompt = Buffer.concat(chunks).toString("utf-8").trim();
      }
    }
    if (!prompt) {
      process.stderr.write("Usage: klaatai run <prompt>\n       klaatai run -  (reads from stdin)\n");
      process.exit(1);
    }
    await runHeadless({ ...opts, prompt });
  });

// ── klaatai upgrade ───────────────────────────────────────────────────────────

program
  .command("upgrade")
  .description("Update klaatcode to the latest version (auto-detects install channel)")
  .option("--check", "Only check whether an update is available; don't install")
  .action(async (opts: { check?: boolean }) => {
    const { runUpgrade } = await import("./commands/upgrade.js");
    await runUpgrade(opts);
  });

// ── klaatai login ─────────────────────────────────────────────────────────────

program
  .command("login")
  .description("Sign in via browser (subscription account)")
  .option("--base-url <url>", "API base URL override")
  .action(async (opts: { baseUrl?: string }) => {
    const config  = loadConfig();
    const baseUrl = opts.baseUrl ?? config.baseUrl;
    const webUrl  = deriveWebUrl(baseUrl);

    const app    = new App();
    app.onKey("ctrl+c", () => app.quit());
    const appDone = app.run(() => {});
    const splash  = await runSplash(app, { status: "Opening browser to sign in…" });
    // OAuth (subscription JWT — quota/units + tier hints honored). No API-key path.
    const oauthCreds = await startOAuthBrowserAuth(webUrl, baseUrl, splash.setSplashStatus, 120_000);
    if (oauthCreds?.accessToken) {
      saveCredentials(oauthCreds); // full overwrite — clears any legacy credential
    }
    splash.unmount();
    app.quit();
    await appDone;

    if (!oauthCreds?.accessToken) {
      console.error("  Sign-in failed or timed out. Run: klaatai login");
      process.exit(1);
    }
    console.log("\n  Signed in successfully.");
    console.log(`  Account: ${oauthCreds.email ?? "subscription"} (subscription quota)\n`);
  });

// ── klaatai logout ────────────────────────────────────────────────────────────

program
  .command("logout")
  .description("Clear all stored credentials")
  .action(() => { runLogout(); });

// ── klaatai whoami ────────────────────────────────────────────────────────────

program
  .command("whoami")
  .description("Show current user info and backend status")
  .option("--base-url <url>", "API base URL override")
  .option("--json", "Output machine-readable JSON")
  .action(async (opts: { baseUrl?: string; json?: boolean }) => {
    const config = loadConfig();
    await runWhoami(opts.baseUrl ?? config.baseUrl, opts.json === true);
  });

// ── klaatai serve ─────────────────────────────────────────────────────────────

/**
 * HTTP serve mode: expose KlaatAI as a local REST API.
 *
 *   POST /v1/chat        — { messages, tier?, stream? } → SSE stream or JSON
 *   POST /v1/run         — { prompt, tier?, system? }   → SSE stream
 *   GET  /v1/health      — { status, version }
 *   GET  /v1/info        — { version, baseUrl, tier? }
 *
 * Designed for IDE extensions, scripts, and web UIs to talk to KlaatAI.
 */
async function runServe(opts: { port: number; apiKey?: string; baseUrl?: string }): Promise<void> {
  const config  = loadConfig();
  const baseUrl = opts.baseUrl ?? config.baseUrl;
  const apiKey  = opts.apiKey ?? process.env["KLAATAI_API_KEY"] ?? await getValidAuthToken();

  if (!apiKey) {
    process.stderr.write("No API key found. Run: klaatai login\n");
    process.exit(1);
  }

  const client = new KlaatAIClient({ apiKey, baseUrl });

  function jsonResponse(res: ServerResponse, status: number, body: unknown): void {
    const payload = JSON.stringify(body);
    res.writeHead(status, { "Content-Type": "application/json", "Access-Control-Allow-Origin": "*" });
    res.end(payload);
  }

  async function readBody(req: IncomingMessage): Promise<string> {
    return new Promise((resolve, reject) => {
      const chunks: Buffer[] = [];
      req.on("data", (c: Buffer) => chunks.push(c));
      req.on("end", () => resolve(Buffer.concat(chunks).toString("utf-8")));
      req.on("error", reject);
    });
  }

  const server = createServer(async (req: IncomingMessage, res: ServerResponse) => {
    const url    = req.url ?? "/";
    const method = req.method?.toUpperCase() ?? "GET";

    // CORS preflight
    if (method === "OPTIONS") {
      res.writeHead(204, {
        "Access-Control-Allow-Origin": "*",
        "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
        "Access-Control-Allow-Headers": "Content-Type, Authorization",
      });
      res.end();
      return;
    }

    // GET /v1/health
    if (method === "GET" && url === "/v1/health") {
      jsonResponse(res, 200, { status: "ok", version: VERSION });
      return;
    }

    // GET /v1/info
    if (method === "GET" && url === "/v1/info") {
      jsonResponse(res, 200, { version: VERSION, baseUrl, routing: config.routingDisplay ?? "minimal" });
      return;
    }

    // POST /v1/chat — stream chat completion
    if (method === "POST" && url === "/v1/chat") {
      let body: { messages?: Message[]; tier?: string; stream?: boolean };
      try {
        body = JSON.parse(await readBody(req));
      } catch {
        jsonResponse(res, 400, { error: "Invalid JSON body" });
        return;
      }
      if (!Array.isArray(body.messages) || body.messages.length === 0) {
        jsonResponse(res, 400, { error: "messages array required" });
        return;
      }

      const wantStream = body.stream !== false; // default: stream
      if (wantStream) {
        res.writeHead(200, {
          "Content-Type": "text/event-stream",
          "Cache-Control": "no-cache",
          "Connection": "keep-alive",
          "Access-Control-Allow-Origin": "*",
        });
        try {
          for await (const chunk of client.chatStream(body.messages, { tier: body.tier })) {
            if (chunk.type === "token" && chunk.text) {
              res.write(`data: ${JSON.stringify({ type: "token", text: chunk.text })}\n\n`);
            } else if (chunk.type === "metadata") {
              res.write(`data: ${JSON.stringify(chunk)}\n\n`);
            } else if (chunk.type === "error") {
              res.write(`data: ${JSON.stringify({ type: "error", error: chunk.error })}\n\n`);
            } else if (chunk.type === "done") {
              res.write(`data: ${JSON.stringify({ type: "done" })}\n\n`);
            }
          }
        } catch (err) {
          res.write(`data: ${JSON.stringify({ type: "error", error: String(err) })}\n\n`);
        }
        res.end();
      } else {
        // Non-streaming: accumulate and return JSON
        let fullText = "";
        let meta: unknown = null;
        try {
          for await (const chunk of client.chatStream(body.messages, { tier: body.tier })) {
            if (chunk.type === "token") fullText += chunk.text ?? "";
            if (chunk.type === "metadata") meta = chunk;
          }
        } catch (err) {
          jsonResponse(res, 500, { error: String(err) });
          return;
        }
        jsonResponse(res, 200, { content: fullText, metadata: meta });
      }
      return;
    }

    // POST /v1/run — simple prompt → stream
    if (method === "POST" && url === "/v1/run") {
      let body: { prompt?: string; tier?: string; system?: string };
      try {
        body = JSON.parse(await readBody(req));
      } catch {
        jsonResponse(res, 400, { error: "Invalid JSON body" });
        return;
      }
      if (!body.prompt) {
        jsonResponse(res, 400, { error: "prompt required" });
        return;
      }
      const msgs: Message[] = [];
      if (body.system) msgs.push({ role: "system", content: body.system });
      msgs.push({ role: "user", content: body.prompt });

      res.writeHead(200, {
        "Content-Type": "text/event-stream",
        "Cache-Control": "no-cache",
        "Connection": "keep-alive",
        "Access-Control-Allow-Origin": "*",
      });
      try {
        for await (const chunk of client.chatStream(msgs, { tier: body.tier })) {
          if (chunk.type === "token" && chunk.text) {
            res.write(`data: ${JSON.stringify({ type: "token", text: chunk.text })}\n\n`);
          } else if (chunk.type === "done") {
            res.write(`data: ${JSON.stringify({ type: "done" })}\n\n`);
          } else if (chunk.type === "error") {
            res.write(`data: ${JSON.stringify({ type: "error", error: chunk.error })}\n\n`);
          }
        }
      } catch (err) {
        res.write(`data: ${JSON.stringify({ type: "error", error: String(err) })}\n\n`);
      }
      res.end();
      return;
    }

    jsonResponse(res, 404, { error: "Not found", hint: "Available: GET /v1/health, GET /v1/info, POST /v1/chat, POST /v1/run" });
  });

  server.listen(opts.port, "127.0.0.1", () => {
    console.log(`\n  KLAAT CODE — HTTP serve mode`);
    console.log(`  Listening on http://127.0.0.1:${opts.port}`);
    console.log(`\n  Endpoints:`);
    console.log(`    GET  /v1/health   — health check`);
    console.log(`    GET  /v1/info     — version + config`);
    console.log(`    POST /v1/chat     — chat completion (SSE stream by default)`);
    console.log(`    POST /v1/run      — single prompt → SSE stream`);
    console.log(`\n  Press ctrl+c to stop.\n`);
  });

  // Graceful shutdown
  process.on("SIGINT", () => {
    server.close(() => {
      console.log("\n  Server stopped.");
      process.exit(0);
    });
  });

  // Keep process alive
  await new Promise<void>(() => { /* run until SIGINT */ });
}

program
  .command("serve")
  .description("Start a local HTTP server exposing KlaatAI as a REST/SSE API")
  .option("--port <n>", "Port to listen on", "4200")
  .option("--api-key <key>", "API key override")
  .option("--base-url <url>", "API base URL override")
  .action(async (opts: { port: string; apiKey?: string; baseUrl?: string }) => {
    await runServe({ port: parseInt(opts.port, 10) || 4200, apiKey: opts.apiKey, baseUrl: opts.baseUrl });
  });

// ── klaatai web ───────────────────────────────────────────────────────────────

/**
 * Browser web UI: starts a local HTTP server that serves a full chat UI
 * at http://localhost:<port> and exposes the KlaatAI REST/SSE API.
 * Opens the browser automatically after binding.
 */
async function runWeb(opts: { port: number; apiKey?: string; baseUrl?: string; noBrowser?: boolean }): Promise<void> {
  const config  = loadConfig();
  const baseUrl = opts.baseUrl ?? config.baseUrl;
  const apiKey  = opts.apiKey ?? process.env["KLAATAI_API_KEY"] ?? await getValidAuthToken();

  if (!apiKey) {
    process.stderr.write("No API key found. Run: klaatai login\n");
    process.exit(1);
  }

  const client = new KlaatAIClient({ apiKey, baseUrl });

  function jsonResponse(res: ServerResponse, status: number, body: unknown): void {
    const payload = JSON.stringify(body);
    res.writeHead(status, { "Content-Type": "application/json", "Access-Control-Allow-Origin": "*" });
    res.end(payload);
  }

  async function readBody(req: IncomingMessage): Promise<string> {
    return new Promise((resolve, reject) => {
      const chunks: Buffer[] = [];
      req.on("data", (c: Buffer) => chunks.push(c));
      req.on("end",  () => resolve(Buffer.concat(chunks).toString("utf-8")));
      req.on("error", reject);
    });
  }

  /** Minimal markdown → HTML: fenced code blocks, inline code, bold, paragraphs */
  function mdToHtml(text: string): string {
    const esc = (s: string) => s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
    // fenced code blocks
    const FENCE = "```";
    let h = text;
    const fenceRe = new RegExp(FENCE + "(\\w*)\\n?([\\s\\S]*?)" + FENCE, "g");
    h = h.replace(fenceRe, (_: string, lang: string, code: string) =>
      `<pre><code class="lang-${lang || "text"}">${esc(code.trimEnd())}</code></pre>`,
    );
    h = h.replace(/`([^`]+)`/g, (_: string, c: string) => `<code>${esc(c)}</code>`);
    h = h.replace(/\*\*([^*]+)\*\*/g, "<strong>$1</strong>");
    h = h.split("\n\n").map(p => p.startsWith("<pre>") ? p : `<p>${p.replace(/\n/g, "<br/>")}</p>`).join("\n");
    return h;
  }

  void mdToHtml; // used indirectly — reserved for future server-side rendering

  const WEB_HTML = `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8"/>
<meta name="viewport" content="width=device-width,initial-scale=1"/>
<title>KlaatAI Web</title>
<style>
*{box-sizing:border-box;margin:0;padding:0}
:root{
  --bg:#0a0a0a;--fg:#e5e5e5;--border:#1e1e1e;--input-bg:#111;
  --accent:#7c3aed;--accent2:#a78bfa;--muted:#6b7280;
  --user-bg:#1a1a2e;--asst-bg:#0f172a;--code-bg:#111827;
  --error:#f87171;--success:#22c55e
}
html,body{height:100%;background:var(--bg);color:var(--fg);font-family:'Segoe UI',system-ui,sans-serif;font-size:14px}
#app{height:100%;display:flex;flex-direction:column}
/* Header */
#hdr{display:flex;align-items:center;justify-content:space-between;padding:10px 16px;border-bottom:1px solid var(--border);background:#050505;flex-shrink:0}
#hdr .logo{font-weight:700;font-size:15px;color:var(--accent2);letter-spacing:0.08em}
#hdr .meta{display:flex;align-items:center;gap:10px;font-size:11px;color:var(--muted)}
.dot{width:8px;height:8px;border-radius:50%;background:#374151}
.dot.on{background:var(--success)}.dot.off{background:var(--error)}
#hdr button{background:transparent;border:1px solid var(--border);color:var(--muted);border-radius:5px;padding:3px 10px;cursor:pointer;font-size:11px;transition:all .2s}
#hdr button:hover{border-color:var(--accent2);color:var(--fg)}
/* Messages */
#msgs{flex:1;overflow-y:auto;padding:16px;display:flex;flex-direction:column;gap:12px}
.msg{display:flex;flex-direction:column;gap:4px;animation:fi .15s ease}
@keyframes fi{from{opacity:0;transform:translateY(4px)}to{opacity:1;transform:translateY(0)}}
.msg .lbl{font-size:11px;font-weight:700;letter-spacing:.1em;text-transform:uppercase}
.msg.user .lbl{color:var(--accent2)}.msg.asst .lbl{color:var(--success)}.msg.err .lbl{color:var(--error)}
.msg .body{background:var(--asst-bg);border-radius:7px;padding:10px 14px;line-height:1.65}
.msg.user .body{background:var(--user-bg);border-left:3px solid var(--accent)}
.msg.err .body{border-left:3px solid var(--error);color:var(--error)}
.msg.stream .body::after{content:"▌";animation:bl .8s step-start infinite}
@keyframes bl{50%{opacity:0}}
.msg .body pre{background:var(--code-bg);border:1px solid var(--border);border-radius:5px;padding:10px 12px;overflow-x:auto;margin:8px 0;font-family:'JetBrains Mono','Fira Code',monospace;font-size:12.5px}
.msg .body code{font-family:inherit;color:#93c5fd}
.msg .body p{margin-bottom:6px}.msg .body p:last-child{margin-bottom:0}
.msg .body strong{color:#f3f4f6}
/* Empty */
#empty{text-align:center;padding:60px 24px;color:var(--muted)}
#empty h2{color:var(--accent2);margin-bottom:10px;font-size:18px}
#empty p{line-height:1.7;font-size:13px}
#empty .cmds{margin-top:20px;background:#111;border-radius:8px;padding:16px;text-align:left;display:inline-block;min-width:320px}
#empty .cmds code{color:var(--accent2);font-family:monospace}
#empty .cmds p{margin-bottom:6px;font-size:12px}
/* Input */
#inp-area{border-top:1px solid var(--border);padding:12px 16px;display:flex;flex-direction:column;gap:8px;flex-shrink:0;background:#080808}
#inp-row{display:flex;gap:8px;align-items:flex-end}
textarea#inp{flex:1;background:var(--input-bg);color:var(--fg);border:1px solid var(--border);border-radius:7px;padding:9px 13px;font-family:inherit;font-size:13.5px;resize:none;min-height:40px;max-height:150px;outline:none;transition:border-color .2s;overflow-y:auto;line-height:1.5}
textarea#inp:focus{border-color:var(--accent)}
textarea#inp::placeholder{color:var(--muted)}
#send{background:var(--accent);color:#fff;border:none;border-radius:7px;padding:9px 18px;cursor:pointer;font-size:14px;font-weight:600;height:40px;flex-shrink:0;transition:background .2s,opacity .2s}
#send:hover{background:#6d28d9}#send:disabled{opacity:.4;cursor:default}
#inp-foot{display:flex;justify-content:space-between;font-size:11px;color:var(--muted)}
</style>
</head>
<body>
<div id="app">
  <div id="hdr">
    <span class="logo">KLAAT AI</span>
    <div class="meta">
      <span class="dot" id="dot"></span>
      <span id="st">Connecting…</span>
    </div>
    <div>
      <button onclick="clearChat()">Clear</button>
    </div>
  </div>
  <div id="msgs">
    <div id="empty">
      <h2>KlaatAI Web</h2>
      <p>Your AI coding assistant in the browser.<br/>Type a message below to get started.</p>
      <div class="cmds">
        <p><code>klaatai serve --port ${opts.port}</code> must be running</p>
        <p>Try: <code>Fix the TODO in main.ts</code></p>
        <p>Try: <code>What is the tech stack?</code></p>
        <p>Try: <code>Write unit tests for the auth module</code></p>
      </div>
    </div>
  </div>
  <div id="inp-area">
    <div id="inp-row">
      <textarea id="inp" rows="1" placeholder='Ask anything… "Explain the auth flow"'></textarea>
      <button id="send" onclick="send()">Send</button>
    </div>
    <div id="inp-foot">
      <span>Enter to send · Shift+Enter for newline</span>
      <span id="cost"></span>
    </div>
  </div>
</div>
<script>
(function(){
  "use strict";
  var msgs=[],totalCost=0,streaming=false;
  var inpEl=document.getElementById("inp");
  var sendBtn=document.getElementById("send");
  var msgsEl=document.getElementById("msgs");
  var emptyEl=document.getElementById("empty");
  var dotEl=document.getElementById("dot");
  var stEl=document.getElementById("st");
  var costEl=document.getElementById("cost");

  inpEl.addEventListener("input",function(){
    inpEl.style.height="auto";
    inpEl.style.height=Math.min(inpEl.scrollHeight,150)+"px";
  });
  inpEl.addEventListener("keydown",function(e){
    if(e.key==="Enter"&&!e.shiftKey){e.preventDefault();send();}
  });

  function setStatus(ok){
    dotEl.className="dot "+(ok?"on":"off");
    stEl.textContent=ok?"Connected":"Disconnected";
  }

  fetch("/v1/health").then(function(r){setStatus(r.ok);}).catch(function(){setStatus(false);});

  function escHtml(s){
    return s.replace(/&/g,"&amp;").replace(/</g,"&lt;").replace(/>/g,"&gt;");
  }

  function renderContent(text){
    return escHtml(text).replace(/\\n/g,"<br/>");
  }

  function appendMsg(role,content,id,stream){
    emptyEl.style.display="none";
    var div=document.createElement("div");
    div.className="msg "+(role==="user"?"user":role==="error"?"err":"asst")+(stream?" stream":"");
    if(id) div.id="msg-"+id;
    var lbl=document.createElement("div");
    lbl.className="lbl";lbl.textContent=role==="user"?"You":"KlaatAI";
    var body=document.createElement("div");
    body.className="body";
    if(content) body.innerHTML=renderContent(content);
    div.appendChild(lbl);div.appendChild(body);
    msgsEl.appendChild(div);
    msgsEl.scrollTop=msgsEl.scrollHeight;
    return div;
  }

  window.send=function(){
    var text=inpEl.value.trim();
    if(!text||streaming) return;
    inpEl.value="";inpEl.style.height="auto";
    msgs.push({role:"user",content:text});
    appendMsg("user",text,null,false);

    var id="a-"+Date.now();
    var div=appendMsg("asst","",id,true);
    var bodyEl=div.querySelector(".body");
    var raw="";
    streaming=true;sendBtn.disabled=true;

    fetch("/v1/chat",{
      method:"POST",
      headers:{"Content-Type":"application/json"},
      body:JSON.stringify({messages:msgs,stream:true})
    }).then(function(res){
      if(!res.ok){throw new Error("HTTP "+res.status);}
      setStatus(true);
      var reader=res.body.getReader();
      var dec=new TextDecoder();
      var buf="";
      function read(){
        reader.read().then(function(r){
          if(r.done){
            div.classList.remove("stream");
            msgs.push({role:"assistant",content:raw});
            streaming=false;sendBtn.disabled=false;
            return;
          }
          buf+=dec.decode(r.value,{stream:true});
          var lines=buf.split("\\n");
          buf=lines.pop()||"";
          lines.forEach(function(line){
            if(!line.startsWith("data: ")) return;
            var json=line.slice(6).trim();
            if(json==="[DONE]") return;
            try{
              var p=JSON.parse(json);
              if(p.type==="token"&&p.text){
                raw+=p.text;
                bodyEl.innerHTML=renderContent(raw);
                msgsEl.scrollTop=msgsEl.scrollHeight;
              } else if(p.type==="metadata"&&p.cost){
                totalCost+=p.cost;
                costEl.textContent="Session: $"+totalCost.toFixed(4);
              }
            }catch(e){}
          });
          read();
        }).catch(function(err){
          bodyEl.textContent="Stream error: "+err.message;
          div.classList.remove("stream");div.classList.add("err");
          streaming=false;sendBtn.disabled=false;
        });
      }
      read();
    }).catch(function(err){
      bodyEl.textContent="Could not connect. Is klaatai serve running on port ${opts.port}?";
      div.classList.remove("stream");div.classList.add("err");
      setStatus(false);
      streaming=false;sendBtn.disabled=false;
    });
  };

  window.clearChat=function(){
    msgs=[];totalCost=0;
    msgsEl.innerHTML="";msgsEl.appendChild(emptyEl);
    emptyEl.style.display="block";
    costEl.textContent="";
  };
})();
</script>
</body>
</html>`;

  const server = createServer(async (req: IncomingMessage, res: ServerResponse) => {
    const url    = req.url ?? "/";
    const method = req.method?.toUpperCase() ?? "GET";

    // CORS preflight
    if (method === "OPTIONS") {
      res.writeHead(204, {
        "Access-Control-Allow-Origin":  "*",
        "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
        "Access-Control-Allow-Headers": "Content-Type, Authorization",
      });
      res.end();
      return;
    }

    // Serve the web UI at GET /
    if (method === "GET" && (url === "/" || url === "/index.html")) {
      res.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
      res.end(WEB_HTML);
      return;
    }

    // GET /v1/health
    if (method === "GET" && url === "/v1/health") {
      const payload = JSON.stringify({ status: "ok", version: VERSION });
      res.writeHead(200, { "Content-Type": "application/json", "Access-Control-Allow-Origin": "*" });
      res.end(payload);
      return;
    }

    // GET /v1/info
    if (method === "GET" && url === "/v1/info") {
      const payload = JSON.stringify({ version: VERSION, baseUrl, routing: config.routingDisplay });
      res.writeHead(200, { "Content-Type": "application/json", "Access-Control-Allow-Origin": "*" });
      res.end(payload);
      return;
    }

    // POST /v1/chat
    if (method === "POST" && url === "/v1/chat") {
      let body: { messages?: Message[]; tier?: string; stream?: boolean };
      try { body = JSON.parse(await readBody(req)); }
      catch { res.writeHead(400, { "Content-Type": "application/json" }); res.end(JSON.stringify({ error: "Invalid JSON" })); return; }
      if (!Array.isArray(body.messages) || body.messages.length === 0) {
        res.writeHead(400, { "Content-Type": "application/json" }); res.end(JSON.stringify({ error: "messages required" })); return;
      }
      res.writeHead(200, {
        "Content-Type": "text/event-stream",
        "Cache-Control": "no-cache",
        "Connection":   "keep-alive",
        "Access-Control-Allow-Origin": "*",
      });
      try {
        for await (const chunk of client.chatStream(body.messages, { tier: body.tier })) {
          if (chunk.type === "token"    && chunk.text)  res.write(`data: ${JSON.stringify({ type: "token", text: chunk.text })}\n\n`);
          else if (chunk.type === "metadata")           res.write(`data: ${JSON.stringify(chunk)}\n\n`);
          else if (chunk.type === "error")              res.write(`data: ${JSON.stringify({ type: "error", error: chunk.error })}\n\n`);
          else if (chunk.type === "done")               res.write(`data: ${JSON.stringify({ type: "done" })}\n\n`);
        }
      } catch (err) {
        res.write(`data: ${JSON.stringify({ type: "error", error: String(err) })}\n\n`);
      }
      res.end();
      return;
    }

    res.writeHead(404, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ error: "Not found" }));
  });

  server.listen(opts.port, "127.0.0.1", () => {
    const url = `http://localhost:${opts.port}`;
    console.log(`\n  KLAAT AI — Web UI`);
    console.log(`  Listening on ${url}`);
    console.log(`\n  Opening browser…`);
    console.log(`  Press ctrl+c to stop.\n`);

    if (!opts.noBrowser) {
      // Open browser (cross-platform)
      const opener = process.platform === "darwin" ? "open"
                   : process.platform === "win32"  ? "start"
                   : "xdg-open";
      _openBrowser(opener, [`http://localhost:${opts.port}`], { stdio: "ignore", shell: process.platform === "win32" });
    }
  });

  process.on("SIGINT", () => { server.close(() => { console.log("\n  Stopped."); process.exit(0); }); });
  await new Promise<void>(() => { /* run until SIGINT */ });
}

program
  .command("web")
  .description("Start a local web UI for KlaatAI in the browser")
  .option("--port <n>",    "Port to listen on", "4200")
  .option("--api-key <key>", "API key override")
  .option("--base-url <url>", "API base URL override")
  .option("--no-browser",  "Don't open the browser automatically")
  .action(async (opts: { port: string; apiKey?: string; baseUrl?: string; noBrowser?: boolean }) => {
    await runWeb({ port: parseInt(opts.port, 10) || 4200, apiKey: opts.apiKey, baseUrl: opts.baseUrl, noBrowser: opts.noBrowser });
  });

// ─── Parse ───────────────────────────────────────────────────────────────────

program.parseAsync(process.argv).catch((err: unknown) => {
  console.error(err instanceof Error ? err.message : String(err));
  process.exit(1);
});
