/**
 * KlaatTUI — Welcome / onboarding screen.
 *
 * A professional two-panel banner: the Klaatu mascot + greeting on the left,
 * getting-started tips on the right, a value-prop highlight below, all inside
 * a rounded card. Waits for Enter.
 */

import {
  App, CellBuffer, type Rect,
  drawBorder, stringWidth, hideCursor,
} from "../engine/index.js";
import { MASCOT, mascotWidth, type MascotRow } from "./mascot.js";
import { version as VERSION } from "../../package.json";

const VIOLET = "#c4a0ff";
const MAGENTA = "#ffa1f6";
const DIM = "#6b7280";
const CYAN = "#22d3ee";
const GREEN = "#4ade80";

export interface WelcomeOpts {
  projectPath?: string;
  userLabel?: string;
}

function drawMascot(buf: CellBuffer, x: number, y: number, rows: MascotRow[]): void {
  for (let i = 0; i < rows.length; i++) {
    let cx = x;
    for (const seg of rows[i]!) {
      buf.write(y + i, cx, seg.text, { fg: seg.fg, bold: seg.bold });
      cx += [...seg.text].length;
    }
  }
}

function drawWelcome(buf: CellBuffer, area: Rect, opts: WelcomeOpts): void {
  hideCursor();

  // ── Card geometry ─────────────────────────────────────────────────────
  const boxW = Math.min(area.width - 4, 92);
  const boxX = area.x + 2;
  const boxY = area.y + 2;
  const boxH = 11;
  drawBorder(buf, { x: boxX, y: boxY, width: boxW, height: boxH }, {
    style: "rounded",
    fg: VIOLET,
    title: " ✦ Klaat Code ",
    titleRight: ` v${VERSION} `,
    titleStyle: { fg: VIOLET, bold: true },
  });

  const inX = boxX + 2;
  const inY = boxY + 1;
  const splitX = boxX + 30; // vertical divider between panels

  // vertical divider
  for (let r = boxY + 1; r < boxY + boxH - 1; r++) {
    buf.write(r, splitX, "│", { fg: "#3a3a44" });
  }

  // ── Left panel: mascot + greeting ─────────────────────────────────────
  const mascot = MASCOT.idle;
  const mW = mascotWidth(mascot);
  const mascotX = inX + Math.max(0, Math.floor((splitX - inX - mW) / 2)) - 1;
  drawMascot(buf, mascotX, inY, mascot);

  const greetY = inY + mascot.length + 1;
  const greet = opts.userLabel ? `Hey ${opts.userLabel} 👽` : "Hey there 👽";
  const greetX = inX + Math.max(0, Math.floor((splitX - inX - stringWidth(greet)) / 2));
  buf.write(greetY, greetX, greet, { fg: "white", bold: true });

  const tagline = "smart-routed AI coding";
  const tagX = inX + Math.max(0, Math.floor((splitX - inX - stringWidth(tagline)) / 2));
  buf.write(greetY + 1, tagX, tagline, { fg: DIM });

  // ── Right panel: getting started ──────────────────────────────────────
  const rx = splitX + 3;
  let ry = inY;
  buf.write(ry, rx, "Getting started", { fg: MAGENTA, bold: true });
  ry += 1;
  const tips: Array<[string, string]> = [
    ["/init", "generate project rules"],
    ["@file", "reference a file inline"],
    ["/model", "pin a routing tier"],
    ["ctrl+p", "command palette"],
  ];
  for (const [cmd, desc] of tips) {
    buf.write(ry, rx, cmd.padEnd(8), { fg: CYAN, bold: true });
    buf.write(ry, rx + 8, desc, { fg: "#d4d4d8" });
    ry += 1;
  }
  ry += 1;
  buf.write(ry, rx, "Every prompt auto-routes to the", { fg: DIM });
  ry += 1;
  buf.write(ry, rx, "cheapest model that can nail it.", { fg: DIM });

  // ── Value-prop highlight bar (below the card) ─────────────────────────
  const barY = boxY + boxH + 1;
  buf.write(barY, boxX, "▎", { fg: GREEN, bold: true });
  buf.write(barY, boxX + 2, "More for less.", { fg: GREEN, bold: true });
  buf.write(barY, boxX + 17, "Frontier-grade results at a fraction of the tokens & cost —", { fg: "#d4d4d8" });
  buf.write(barY + 1, boxX + 2, "nano → fast → code → reason → heavy → titan, per request. Tool calls are free.", { fg: "#d4d4d8" });

  // ── Project path ──────────────────────────────────────────────────────
  if (opts.projectPath) {
    const p = opts.projectPath.replace(process.env["HOME"] ?? "", "~");
    const shown = p.length > boxW - 6 ? "…" + p.slice(p.length - (boxW - 7)) : p;
    buf.write(barY + 3, boxX, "in ", { fg: DIM });
    buf.write(barY + 3, boxX + 3, shown, { fg: VIOLET });
  }

  // ── Press Enter ───────────────────────────────────────────────────────
  const enterY = barY + 5;
  buf.write(enterY, boxX, "Press ", { fg: DIM });
  buf.write(enterY, boxX + 6, "Enter", { fg: CYAN, bold: true });
  buf.write(enterY, boxX + 11, " to begin  ·  ", { fg: DIM });
  buf.write(enterY, boxX + 25, "Ctrl+C", { fg: DIM, bold: true });
  buf.write(enterY, boxX + 31, " to quit", { fg: DIM });
}

// ─── runWelcome ───────────────────────────────────────────────────────────────

export function runWelcome(app: App, opts: WelcomeOpts = {}): Promise<void> {
  return new Promise<void>((resolve) => {
    app.setRenderFn((buf, area) => drawWelcome(buf, area, opts));
    const unsub = app.onKey("enter", () => { unsub(); resolve(); });
  });
}
