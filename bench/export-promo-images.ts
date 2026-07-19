/**
 * Render promotional benchmark images (PNG) from the exported benchmarks.json
 * — the same cumulative-cost curve the website shows, baked as a static frame
 * in platform-native sizes for X, LinkedIn, GitHub README, and Reddit.
 *
 * Usage:  bun bench/export-promo-images.ts
 * Output: bench/promo/bench-curve-{x,linkedin,github,reddit}.png
 * Needs:  Google Chrome (headless screenshot).
 */

import { mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { spawnSync } from "node:child_process";

const HERE = dirname(fileURLToPath(import.meta.url));
const OUT_DIR = join(HERE, "promo");
const DATA = JSON.parse(readFileSync(
  join(HERE, "..", "..", "KlaatAi.Klaatu.UI", "src", "content", "benchmarks.json"), "utf-8",
)) as {
  taskCount: number;
  agents: {
    id: string; label: string; model: string; highlight: boolean; solved: number; total: number;
    costEstimated: boolean; costPerSolve: number | null;
    tasks: { id: string; costUsd: number }[];
  }[];
  taskIndex: { id: string }[];
};

import { existsSync } from "node:fs";
const CHROME = [
  "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
  "/Applications/Google Chrome 2.app/Contents/MacOS/Google Chrome",
  "/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge",
].find(existsSync);
if (!CHROME) { console.error("No Chromium-based browser found for headless rendering."); process.exit(1); }

const AGENT_COLOR: Record<string, string> = {
  klaatcode: "#8b5cf6", opencode: "#199e70", claude: "#3987e5",
  grok: "#d95926", cursor: "#d55181",
};

const SIZES = [
  { name: "x", w: 1600, h: 900 },
  { name: "linkedin", w: 1200, h: 627 },
  { name: "github", w: 1280, h: 640 },
  { name: "reddit", w: 1200, h: 675 },
];

// ── Series math (mirrors the website's CostCurve) ────────────────────────────
const n = DATA.taskIndex.length;
const series = DATA.agents
  .filter(a => a.costPerSolve !== null)
  .map(a => {
    const byId = new Map(a.tasks.map(t => [t.id, t.costUsd]));
    let run = 0;
    const cum = DATA.taskIndex.map(ti => (run += byId.get(ti.id) ?? 0));
    const costs = a.tasks.map(t => t.costUsd);
    const uniform = costs.length > 1 && costs.every(c => Math.abs(c - costs[0]!) < 1e-9);
    return { a, cum, uniform };
  });

const klaat = DATA.agents.find(a => a.highlight);
const rivals = DATA.agents.filter(a => !a.highlight && a.costPerSolve !== null);
const cheapestRival = rivals.reduce((m, x) => (x.costPerSolve! < m.costPerSolve! ? x : m));
const multiple = (cheapestRival.costPerSolve! / klaat!.costPerSolve!).toFixed(1);
const dearest = rivals.reduce((m, x) => (x.costPerSolve! > m.costPerSolve! ? x : m));
const bigMultiple = (dearest.costPerSolve! / klaat!.costPerSolve!).toFixed(1);

function chartSvg(w: number, h: number): string {
  const top = 14, right = 170, bottom = 34, left = 56;
  const plotW = w - left - right, plotH = h - top - bottom;
  const maxY = Math.max(1, ...series.map(s => s.cum[n - 1] ?? 0)) * 1.04;
  const x = (i: number) => left + (i / (n - 1)) * plotW;
  const y = (v: number) => top + plotH - (v / maxY) * plotH;

  const grid = [];
  for (let v = 1; v < maxY; v++) {
    grid.push(`<line x1="${left}" x2="${w - right}" y1="${y(v)}" y2="${y(v)}" stroke="rgba(255,255,255,0.07)"/>
      <text x="${left - 10}" y="${y(v) + 4}" text-anchor="end" font-size="14" fill="#52525b" font-family="ui-monospace,monospace">$${v}</text>`);
  }

  const paths = series.map(({ a, cum, uniform }) => {
    const d = cum.map((v, i) => `${i === 0 ? "M" : "L"}${x(i).toFixed(1)},${y(v).toFixed(1)}`).join(" ");
    return `<path d="${d}" fill="none" stroke="${AGENT_COLOR[a.id] ?? "#71717a"}" stroke-width="${a.highlight ? 5 : 3}" ${uniform ? 'stroke-dasharray="8 8"' : ""} stroke-linecap="round"/>`;
  }).join("\n");

  // End labels, de-collided (two lines ≈ 40px block)
  const ls = series.map(s => ({ s, ly: y(s.cum[n - 1] ?? 0) })).sort((p, q) => p.ly - q.ly);
  for (let i = 1; i < ls.length; i++) if (ls[i]!.ly - ls[i - 1]!.ly < 42) ls[i]!.ly = ls[i - 1]!.ly + 42;
  const over = (ls[ls.length - 1]?.ly ?? 0) - (h - 40);
  if (over > 0) for (const l of ls) l.ly -= over;
  const labels = ls.map(({ s, ly }) => `
    <text x="${w - right + 14}" y="${ly + 5}" font-size="17" font-weight="${s.a.highlight ? 800 : 600}" fill="${AGENT_COLOR[s.a.id]}" font-family="-apple-system,system-ui,sans-serif">${s.a.label}</text>
    <text x="${w - right + 14}" y="${ly + 24}" font-size="15" fill="#a1a1aa" font-family="ui-monospace,monospace">${s.a.costEstimated ? "~" : ""}$${(s.cum[n - 1] ?? 0).toFixed(2)}</text>`).join("\n");

  const xticks = [1, 11, 22, n].map(t =>
    `<text x="${x(t - 1)}" y="${h - 10}" text-anchor="middle" font-size="13" fill="#52525b" font-family="ui-monospace,monospace">${t}</text>`).join("");

  return `<svg viewBox="0 0 ${w} ${h}" width="${w}" height="${h}" xmlns="http://www.w3.org/2000/svg">
    ${grid.join("\n")}
    <line x1="${left}" x2="${w - right}" y1="${y(0)}" y2="${y(0)}" stroke="rgba(255,255,255,0.14)"/>
    ${xticks}
    <text x="${left + plotW / 2}" y="${h - 10}" text-anchor="middle" font-size="12" fill="#3f3f46" font-family="-apple-system,system-ui,sans-serif">tasks completed →</text>
    ${paths}
    ${labels}
  </svg>`;
}

function pageHtml(w: number, h: number): string {
  const pad = Math.round(h * 0.055);
  const headFs = Math.round(h * 0.062);
  const subFs = Math.round(h * 0.028);
  const chartH = Math.round(h * 0.56);
  const solvedNote = `${klaat!.solved}/${klaat!.total} solved · ${DATA.taskCount} real coding tasks · one harness, identical prompts`;
  return `<!doctype html><html><head><meta charset="utf-8"><style>
    * { margin:0; box-sizing:border-box; }
    body { width:${w}px; height:${h}px; background:#09090b; color:#fff; overflow:hidden;
           font-family:-apple-system,system-ui,'Segoe UI',sans-serif; }
    .wrap { padding:${pad}px ${pad}px ${Math.round(pad * 0.6)}px; height:100%; display:flex; flex-direction:column; }
    .brand { display:flex; align-items:center; justify-content:space-between; }
    .brand .name { font-size:${Math.round(subFs * 1.15)}px; font-weight:800; letter-spacing:.02em; }
    .brand .name span { color:#8b5cf6; }
    .brand .handle { font-size:${Math.round(subFs * 0.92)}px; color:#71717a; }
    h1 { font-size:${headFs}px; font-weight:800; letter-spacing:-0.02em; margin-top:${Math.round(pad * 0.5)}px; }
    h1 .v { color:#a78bfa; }
    .sub { font-size:${subFs}px; color:#a1a1aa; margin-top:${Math.round(subFs * 0.5)}px; }
    .chart { margin-top:${Math.round(pad * 0.55)}px; flex:1; }
    .foot { display:flex; justify-content:space-between; font-size:${Math.round(subFs * 0.88)}px; color:#71717a; }
    .foot .repro { color:#8b5cf6; font-weight:600; }
  </style></head><body><div class="wrap">
    <div class="brand"><div class="name">✳ Klaat<span>AI</span></div><div class="handle">@klaatAI</div></div>
    <h1>${multiple}× cheaper than the nearest rival.<br><span class="v">${bigMultiple}× cheaper than ${dearest.label}.</span></h1>
    <div class="sub">${solvedNote}</div>
    <div class="chart">${chartSvg(w - pad * 2, chartH)}</div>
    <div class="foot"><span>cumulative $ across the suite · ~ = normalized to published API rates · dashed = per-task split estimated</span><span class="repro">klaatai.com/benchmarks</span></div>
  </div></body></html>`;
}

mkdirSync(OUT_DIR, { recursive: true });
for (const { name, w, h } of SIZES) {
  const htmlPath = join(OUT_DIR, `bench-curve-${name}.html`);
  writeFileSync(htmlPath, pageHtml(w, h));
  const png = join(OUT_DIR, `bench-curve-${name}.png`);
  const r = spawnSync(CHROME, [
    "--headless", "--disable-gpu", "--hide-scrollbars", "--force-device-scale-factor=2",
    `--screenshot=${png}`, `--window-size=${w},${h}`, `file://${htmlPath}`,
  ], { encoding: "utf-8", timeout: 60_000 });
  if (r.status !== 0) console.error(`${name}: chrome exited ${r.status}\n${r.stderr?.slice(-300)}`);
  else console.log(`✓ ${png} (${w}×${h} @2x)`);
  rmSync(htmlPath, { force: true }); // html is only a render intermediate
}
