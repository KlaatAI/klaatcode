/**
 * Read a raw image (e.g. a screenshot) from the OS clipboard.
 *
 * Terminals only deliver *text* through paste events, so an image copied to
 * the clipboard never reaches onPaste — the user presses ctrl+v and we pull
 * the bytes straight from the OS:
 *   - macOS:  osascript (`the clipboard as «class PNGf»`) — no extra tools
 *   - Linux:  wl-paste (Wayland) or xclip (X11)
 *   - Windows: PowerShell System.Windows.Forms.Clipboard
 *
 * Returns a tagged result so callers can distinguish "no image at all" from
 * "image found but it exceeds the size cap" — the latter is a real, recoverable
 * user error (full-screen Retina screenshots routinely blow past 8MB as PNG),
 * so we surface it instead of silently treating it like an empty clipboard.
 */

import { spawnSync } from "node:child_process";
import { readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

export const MAX_IMAGE_BYTES = 8 * 1024 * 1024; // API request-size guard

export interface ClipboardImage {
  b64: string;
  mime: string;
}

export type ClipboardImageResult =
  | { ok: true; image: ClipboardImage }
  | { ok: false; reason: "empty" }
  | { ok: false; reason: "too_large"; sizeBytes: number };

/** Build a "too_large" result for a buffer that exceeded the cap. */
function tooLarge(sizeBytes: number): ClipboardImageResult {
  return { ok: false, reason: "too_large", sizeBytes };
}

/** Wrap raw PNG bytes into a success result, or report it was too large. */
function wrapPng(buf: Buffer): ClipboardImageResult | null {
  if (!buf.length) return null;
  if (buf.length > MAX_IMAGE_BYTES) return tooLarge(buf.length);
  return { ok: true, image: { b64: buf.toString("base64"), mime: "image/png" } };
}

function fromMac(): ClipboardImageResult | null {
  // «data PNGf89504E47...» — AppleScript prints the PNG bytes as hex.
  const r = spawnSync("osascript", ["-e", "get the clipboard as «class PNGf»"], {
    encoding: "utf-8", timeout: 5_000, maxBuffer: 64 * 1024 * 1024,
  });
  if (r.status !== 0 || !r.stdout) return null;
  const m = /«data PNGf([0-9A-Fa-f]+)»/.exec(r.stdout);
  if (!m) return null;
  return wrapPng(Buffer.from(m[1]!, "hex"));
}

function fromLinux(): ClipboardImageResult | null {
  for (const [cmd, args] of [
    ["wl-paste", ["-t", "image/png"]],
    ["xclip", ["-selection", "clipboard", "-t", "image/png", "-o"]],
  ] as const) {
    const r = spawnSync(cmd, args as unknown as string[], {
      timeout: 5_000, maxBuffer: 64 * 1024 * 1024,
    });
    if (r.status !== 0 || !r.stdout || r.stdout.length <= 8) continue;
    const res = wrapPng(r.stdout);
    if (res) return res;
  }
  return null;
}

function fromWindows(): ClipboardImageResult | null {
  const tmp = join(tmpdir(), `klaatai-clip-${process.pid}.png`);
  const script =
    "Add-Type -AssemblyName System.Windows.Forms; " +
    "$img = [System.Windows.Forms.Clipboard]::GetImage(); " +
    `if ($img) { $img.Save('${tmp}', [System.Drawing.Imaging.ImageFormat]::Png); 'ok' }`;
  const r = spawnSync("powershell", ["-NoProfile", "-Command", script], {
    encoding: "utf-8", timeout: 10_000,
  });
  if (r.status !== 0 || !r.stdout?.includes("ok")) return null;
  try {
    const buf = readFileSync(tmp);
    return wrapPng(buf);
  } catch {
    return null;
  } finally {
    try { rmSync(tmp, { force: true }); } catch { /* best effort */ }
  }
}

export function readClipboardImage(): ClipboardImageResult {
  try {
    switch (process.platform) {
      case "darwin": return fromMac() ?? { ok: false, reason: "empty" };
      case "linux":  return fromLinux() ?? { ok: false, reason: "empty" };
      case "win32":  return fromWindows() ?? { ok: false, reason: "empty" };
      default:       return { ok: false, reason: "empty" };
    }
  } catch {
    return { ok: false, reason: "empty" };
  }
}