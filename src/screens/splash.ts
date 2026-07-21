/**
 * KlaatTUI — Splash screen (engine-based, no React/Ink).
 *
 * Shows the branded KLAAT CODE wordmark, an animated PulseBar,
 * a dots spinner, and an updateable status line while the CLI boots.
 *
 * Usage:
 *   const { setSplashStatus, unmount } = await runSplash(app, { status: "Starting…" });
 *   setSplashStatus("Connecting…");
 *   unmount(); // cleans up timers
 */

import {
  App, CellBuffer, type Rect,
  splitV, center,
} from "../engine/index.js";
import { Spinner, PulseBar, SPINNER_DOTS } from "../engine/index.js";
import { drawTextLine } from "../engine/index.js";
import { stringWidth } from "../engine/index.js";
import { showCursor, hideCursor } from "../engine/index.js";

// ─── Wordmark ─────────────────────────────────────────────────────────────────

const KLAAT_ROWS = [
  " ██╗  ██╗██╗      █████╗  █████╗ ████████╗",
  " ██║ ██╔╝██║     ██╔══██╗██╔══██╗╚══██╔══╝",
  " █████╔╝ ██║     ███████║███████║   ██║   ",
  " ██╔═██╗ ██║     ██╔══██║██╔══██║   ██║   ",
  " ██║  ██╗███████╗██║  ██║██║  ██║   ██║   ",
  " ╚═╝  ╚═╝╚══════╝╚═╝  ╚═╝╚═╝  ╚═╝   ╚═╝   ",
];
const DEV_ROWS = [
  "  ██████╗ ██████╗ ██████╗ ███████╗",
  " ██╔════╝██╔═══██╗██╔══██╗██╔════╝",
  " ██║     ██║   ██║██║  ██║█████╗  ",
  " ██║     ██║   ██║██║  ██║██╔══╝  ",
  " ╚██████╗╚██████╔╝██████╔╝███████╗",
  "  ╚═════╝ ╚═════╝ ╚═════╝ ╚══════╝",
];
// Combined width of one wordmark row
const WM_W = stringWidth(KLAAT_ROWS[0]! + DEV_ROWS[0]!);
const WM_H = KLAAT_ROWS.length; // 6

// ─── Draw ─────────────────────────────────────────────────────────────────────

interface SplashState {
  status:      string;
  projectPath?: string;
  accent:      string;
  version:     string;
  spinner:     Spinner;
  pulse:       PulseBar;
}

function drawSplash(buf: CellBuffer, area: Rect, st: SplashState): void {
  hideCursor();

  const cols = area.width;

  // ── Top border ──────────────────────────────────────────────────────────────
  const barW  = Math.min(70, cols - 4);
  const barX  = Math.floor((cols - barW) / 2);
  let row = area.y + 1;
  buf.write(row, barX, "━".repeat(barW), { fg: "gray", dim: true });
  row++;

  // ── Wordmark ────────────────────────────────────────────────────────────────
  row++; // top margin
  const wmX = Math.max(area.x, Math.floor((cols - WM_W) / 2));
  for (let i = 0; i < WM_H; i++) {
    const kRow = KLAAT_ROWS[i] ?? "";
    const dRow = DEV_ROWS[i]   ?? "";
    buf.write(row + i, wmX,                         kRow, { bold: true });
    buf.write(row + i, wmX + stringWidth(kRow),     dRow, { fg: st.accent, bold: true });
  }
  row += WM_H + 1;

  // ── Version tagline ─────────────────────────────────────────────────────────
  const tagline = `KlaatCode v${st.version}  ·  Smart models  ·  Smart Way to Develop`;
  drawTextLine(buf, { x: area.x, y: row, width: cols, height: 1 }, row,
    tagline, { fg: "gray", dim: true }, { align: "center" });
  row++;

  if (st.projectPath) {
    const proj = st.projectPath.replace(process.env["HOME"] ?? "", "~");
    const projLabel = "Project: " + proj;
    drawTextLine(buf, { x: area.x, y: row, width: cols, height: 1 }, row,
      projLabel, { fg: "gray", dim: true }, { align: "center" });
    row++;
  }
  row++;

  // ── Separator ───────────────────────────────────────────────────────────────
  buf.write(row, barX, "━".repeat(barW), { fg: "gray", dim: true });
  row += 2;

  // ── PulseBar ────────────────────────────────────────────────────────────────
  const pbW = Math.min(44, cols - 10);
  const pbX = Math.floor((cols - pbW - 4) / 2);
  buf.write(row, pbX, "  [", { fg: "gray", dim: true });
  st.pulse.draw(
    buf,
    { x: pbX + 3, y: row, width: pbW, height: 1 },
    { fg: "magenta" },
    { fg: "gray", dim: true },
  );
  buf.write(row, pbX + 3 + pbW, "]", { fg: "gray", dim: true });
  row += 2;

  // ── Spinner + status ────────────────────────────────────────────────────────
  const statusLines = st.status.split("\n");
  const firstLine = statusLines[0] ?? "";
  const spinnerStr = st.spinner.frame + " ";
  const statusLine = spinnerStr + firstLine;
  const statusX = Math.floor((cols - stringWidth(statusLine)) / 2);
  buf.write(row, statusX, spinnerStr, { fg: "magenta" });
  buf.write(row, statusX + stringWidth(spinnerStr), firstLine, { fg: "cyan" });
  row++;

  // Render additional lines (e.g. fallback URL) with proper wrapping
  for (let li = 1; li < statusLines.length; li++) {
    const line = statusLines[li]!.trim();
    if (!line) { row++; continue; }

    const isUrl = /^https?:\/\//.test(line);
    const maxW = cols - 6; // leave 3 char margin each side

    if (isUrl) {
      // Wrap URL into chunks that fit terminal width
      const chunks: string[] = [];
      for (let i = 0; i < line.length; i += maxW) {
        chunks.push(line.slice(i, i + maxW));
      }
      for (const chunk of chunks) {
        const cx = area.x + 3;
        buf.write(row, cx, chunk, { fg: "#58a6ff", underline: true });
        row++;
      }
    } else {
      const truncated = stringWidth(line) > maxW ? line.slice(0, maxW - 1) + "…" : line;
      const lx = Math.floor((cols - stringWidth(truncated)) / 2);
      buf.write(row, lx, truncated, { fg: "gray", dim: true });
      row++;
    }
  }
  row++;

  // ── Footer ──────────────────────────────────────────────────────────────────
  const footer = "Ctrl+C to cancel  ·  klaatai.com";
  drawTextLine(buf, { x: area.x, y: row, width: cols, height: 1 }, row,
    footer, { fg: "gray", dim: true }, { align: "center" });
}

// ─── runSplash ────────────────────────────────────────────────────────────────

export interface SplashHandle {
  setSplashStatus: (msg: string) => void;
  unmount:         () => void;
}

export async function runSplash(
  app:  App,
  opts: { status?: string; projectPath?: string; accent?: string; version?: string } = {},
): Promise<SplashHandle> {
  const state: SplashState = {
    status:      opts.status ?? "Starting…",
    projectPath: opts.projectPath,
    accent:      opts.accent ?? "#d8b4fe",
    version:     opts.version ?? "0.0.0",
    spinner:     new Spinner(SPINNER_DOTS, 80),
    pulse:       new PulseBar(),
  };

  state.spinner.start(() => app.requestRender());
  state.pulse.start(()   => app.requestRender());

  app.setRenderFn((buf, area) => drawSplash(buf, area, state));

  return {
    setSplashStatus(msg: string) {
      state.status = msg;
      app.requestRender();
    },
    unmount() {
      state.spinner.stop();
      state.pulse.stop();
    },
  };
}
