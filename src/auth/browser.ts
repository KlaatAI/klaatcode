/**
 * Browser-based auth for the KlaatAI CLI.
 *
 * Flow:
 *  1. Start a local HTTP server on a random port.
 *  2. Open the KlaatAI web UI's /klaatu/cli-auth page in the default browser,
 *     passing the local callback URL as a query param.
 *  3. User logs in on the web page.  The page calls POST /v1/api-keys with their
 *     Supabase JWT, gets a raw kl-xxx key, then redirects to our callback URL.
 *  4. Our server receives GET /done?api_key=kl-xxx, extracts the key, and resolves.
 *
 * No polling needed — the browser redirect does the signaling.
 */

import { createServer } from "node:http";
import { type AddressInfo } from "node:net";
import { execSync, spawn } from "node:child_process";
import { randomBytes } from "node:crypto";
import { type Credentials } from "./credentials.js";

export type StatusFn = (msg: string) => void;

// ─── Browser opener ──────────────────────────────────────────────────────────

/** Open a URL in the OS default browser. Fire-and-forget. */
export function openBrowser(url: string): void {
  try {
    const p = process.platform;
    if (p === "darwin") {
      execSync(`open "${url}"`, { stdio: "ignore" });
    } else if (p === "win32") {
      // Neither cmd.exe `start` nor spawn through cmd.exe are safe — cmd always
      // interprets `&` as a command separator regardless of quoting or arg arrays.
      // Use PowerShell's Start-Process which handles URLs with special chars correctly.
      spawn("powershell.exe", ["-NoProfile", "-Command", `Start-Process "${url}"`], {
        stdio: "ignore",
        detached: true,
        windowsHide: true,
      }).unref();
    } else {
      execSync(`xdg-open "${url}"`, { stdio: "ignore" });
    }
  } catch {
    // Swallow — we'll show the URL to the user as fallback
  }
}

// ─── Success page (shown in browser after auth) ───────────────────────────────

const SUCCESS_HTML = `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1" />
  <title>KlaatAI CLI — Authorized</title>
  <style>
    *, *::before, *::after { box-sizing: border-box; margin: 0; padding: 0; }
    body {
      min-height: 100dvh;
      display: flex;
      align-items: center;
      justify-content: center;
      background: #09090b;
      color: #e4e4e7;
      font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif;
    }
    .card {
      text-align: center;
      padding: 56px 48px;
      border: 1px solid #27272a;
      border-radius: 20px;
      max-width: 420px;
      width: calc(100% - 32px);
    }
    .check {
      width: 64px;
      height: 64px;
      border-radius: 50%;
      background: linear-gradient(135deg, #7c3aed, #a78bfa);
      display: flex;
      align-items: center;
      justify-content: center;
      margin: 0 auto 28px;
      font-size: 28px;
    }
    h1 { font-size: 22px; font-weight: 700; color: #a78bfa; margin-bottom: 10px; }
    p  { font-size: 14px; color: #a1a1aa; line-height: 1.65; }
    .small { margin-top: 20px; font-size: 12px; color: #52525b; }
    .brand {
      margin-top: 40px;
      font-size: 11px;
      letter-spacing: 0.15em;
      text-transform: uppercase;
      color: #3f3f46;
    }
  </style>
</head>
<body>
  <div class="card">
    <div class="check">✓</div>
    <h1>CLI Authorized</h1>
    <p>Your terminal is now connected to KlaatAI.<br>Return to your terminal to start chatting.</p>
    <p class="small">You can close this tab.</p>
    <p class="brand">KlaatAI Code Edition</p>
  </div>
</body>
</html>`;

const ERROR_HTML = `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8" />
  <title>KlaatAI CLI — Auth Error</title>
  <style>
    body { min-height:100dvh; display:flex; align-items:center; justify-content:center;
           background:#09090b; color:#e4e4e7; font-family:sans-serif; }
    .card { text-align:center; padding:48px; border:1px solid #27272a; border-radius:16px; max-width:400px; width:calc(100% - 32px); }
    h1 { color:#f87171; margin-bottom:12px; }
    p { color:#a1a1aa; font-size:14px; }
  </style>
</head>
<body>
  <div class="card">
    <h1>Authorization Failed</h1>
    <p>Return to your terminal and try again.</p>
  </div>
</body>
</html>`;

// ─── OAuth flow (preferred) ───────────────────────────────────────────────────

/**
 * Token-in-redirect OAuth flow — the same contract KlaatAI.Code and the
 * VS Code extension use:
 *
 *  1. Local HTTP server on a random port.
 *  2. Browser → {web}/klaatu/cli-auth?flow=oauth&redirect_uri=…&state=…
 *  3. User signs in via Supabase on the web page.
 *  4. Page redirects to /callback?access_token=…&refresh_token=…&expires_in=…
 *     (+ user_id, email); state is CSRF-checked.
 *
 * Unlike the kl- API-key flow, this yields a Supabase JWT session, which the
 * backend treats as an editor client: subscription quota (not credit wallet)
 * and tier hints honored. Returns credentials or null on failure/timeout.
 */
export async function startOAuthBrowserAuth(
  webUrl: string,
  apiUrl: string,
  onStatus: StatusFn,
  timeoutMs = 5 * 60 * 1000,
): Promise<Credentials | null> {
  return new Promise((resolve) => {
    let settled = false;
    const state = randomBytes(16).toString("hex");

    const settle = (result: Credentials | null): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      server.close();
      resolve(result);
    };

    const server = createServer((req, res) => {
      const url = new URL(req.url ?? "/", "http://localhost");

      if (url.pathname === "/callback") {
        const gotState     = url.searchParams.get("state");
        const accessToken  = url.searchParams.get("access_token");
        const refreshToken = url.searchParams.get("refresh_token");
        const expiresIn    = Number(url.searchParams.get("expires_in") ?? 3600);
        const ok = !!accessToken && gotState === state;

        res.writeHead(200, { "Content-Type": "text/html; charset=utf-8", "Cache-Control": "no-store" });
        res.end(ok ? SUCCESS_HTML : ERROR_HTML);

        settle(ok ? {
          accessToken:  accessToken!,
          refreshToken: refreshToken ?? undefined,
          expiresAt:    Math.floor(Date.now() / 1000) + expiresIn,
          userId:       url.searchParams.get("user_id") ?? undefined,
          email:        url.searchParams.get("email") ?? undefined,
        } : null);
        return;
      }

      if (url.pathname === "/ping") {
        res.writeHead(200, { "Content-Type": "text/plain" });
        res.end("ok");
        return;
      }

      res.writeHead(404);
      res.end();
    });

    server.on("error", () => settle(null));

    // Bind to 127.0.0.1 on non-Windows; on Windows also accept localhost
    // connections since some browsers/firewalls route differently.
    const bindHost = process.platform === "win32" ? "0.0.0.0" : "127.0.0.1";

    server.listen(0, bindHost, () => {
      const port = (server.address() as AddressInfo).port;
      // Use localhost on Windows (avoids IPv4/IPv6 mismatch issues in browsers)
      const loopback = process.platform === "win32" ? "localhost" : "127.0.0.1";
      const redirectUri = `http://${loopback}:${port}/callback`;

      const loginUrl =
        `${webUrl.replace(/\/$/, "")}/klaatu/cli-auth` +
        `?flow=oauth` +
        `&redirect_uri=${encodeURIComponent(redirectUri)}` +
        `&state=${state}` +
        `&client_id=klaatai-cli` +
        `&client=cli` +
        `&api_url=${encodeURIComponent(apiUrl)}`;

      onStatus("Opening browser…");
      openBrowser(loginUrl);
      // Show the URL quickly as fallback so user can copy-paste if browser fails
      setTimeout(() => onStatus(`Waiting for browser login…\n  If the browser didn't open, visit:\n  ${loginUrl}`), 2000);
    });

    const timer = setTimeout(() => {
      onStatus("Timed out — run: klaatai login --api-key <key>");
      settle(null);
    }, timeoutMs);
  });
}

