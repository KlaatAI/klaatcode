/**
 * KlaatTUI — REPL screen (full-screen OpenCode-style layout).
 *
 * Uses App.setRenderFn() to display a full-screen split-pane UI:
 *   - Left pane: scrollable chat with markdown rendering
 *   - Right pane: sidebar (context, LSP, modified files)
 *   - Bottom: input area with agent/model metadata and footer
 *   - Status bar at the very bottom
 *
 * All business logic (agentic loop, permissions, slash commands,
 * history, routing) is integrated with real API calls.
 */

import {
  App, CellBuffer, type Rect,
  InputField, ScrollView, Spinner, PulseBar, TabBar, DialogManager, HitGrid,
  drawTextLine,
  drawStyledLine,
  drawBorder,
  span, dim, bold, clickable,
  renderMarkdown,
  takeBottom,
  type StyledLine,
  type Span,
  showCursor, hideCursor,
  SPINNER_DOTS,
  getPalette, type Theme, type ThemePalette,
  THEME_NAMES, THEME_DESCRIPTIONS,
  type KeyEvent,
  stringWidth,
  exitAltScreen, enterAltScreen,
  setRawMode, clearScreen,
  enableMouse, disableMouse,
  enableKitty, disableKitty,
  enableBracketedPaste, disableBracketedPaste,
} from "../engine/index.js";
import {
  KlaatAIClient,
  type Message,
  type ContentPart,
  type KlaatAIMetadata,
  type ToolDefinition,
  type ToolCall,
  type LifetimeUsageStats,
  type QuotaSnapshot,
} from "../api/client.js";
import {
  type Config, type CustomModelConfig, saveConfig, loadConfig, getAuthToken,
  loadCredentials, clearCredentials, resolveCustomModelKey,
} from "../auth/credentials.js";
import {
  type DiffLine, buildEditDiff, buildMultiEditDiff, buildWriteDiff, buildPatchDiff, diffStat, lineOf,
} from "./diff-view.js";
import { parsePatch } from "../tools/apply-patch.js";
import { fuzzyScore } from "../engine/widgets/dialog.js";
import { executeTools, TOOL_DEFINITIONS, configureSandbox } from "../tools/index.js";
import { dialectForTier, toolsForDialect, dialectIncludesExtras, type ToolDialect } from "../tools/dialects.js";
import { PluginRegistry } from "../tools/plugins.js";
import { configureDiagnostics } from "../tools/diagnostics.js";
import { setOutputFilterEnabled } from "../tools/output-filter.js";
import { expandSkill, formatSkillLocation, loadSkills } from "../skills/loader.js";
import { PhaseTracker } from "../agent/phase-budget.js";
import { collectCriticalState, checkSummaryCoverage } from "../agent/collapse-check.js";
import { killAllBackground } from "../tools/background.js";
import { KGIndexer, type IndexProgress } from "../tools/kg-indexer.js";
import { initLocalDb, localDbGetStats } from "../tools/local-db.js";
import { resolveProjectId } from "../utils/project-id.js";
import { MCPManager, loadMCPConfig, type MCPServerConfig } from "../mcp/client.js";
import { seedSystemMessages, MODE_PROMPTS } from "../agent/system-prompt.js";
import { checkForUpdate } from "../utils/update.js";
import { readClipboardImage, MAX_IMAGE_BYTES } from "../utils/clipboard-image.js";
import { SessionLedger } from "../agent/session-ledger.js";
import { COMPACTION_PROMPT, extractSummary, MAX_CONSECUTIVE_COMPACT_FAILURES } from "../agent/compaction-prompt.js";
import { compactMessagesForApi } from "../agent/compaction.js";
import { stripStrayTextToolCallArtifacts } from "../agent/text-tool-artifacts.js";
import { drawWelcomeCard } from "./welcome-card.js";
import {
  renderSessionMarkdown,
  resolveExportPath,
} from "./export-session.js";
import {
  TIER_COSTS, VALID_TIERS, TIER_CONTEXT_WINDOW, SAFE_CONTEXT_BUDGET,
  TIER_COLOR_MAP, KLAATU_MODEL_MAP, formatTok, formatElapsed,
} from "./tiers.js";
import { getPersona, PERSONAS } from "../agent/personas.js";
import { version as APP_VERSION } from "../../package.json";
import { MCP_PRESETS, getMCPPreset } from "../mcp/presets.js";
import {
  checkPermission,
  summarizeTool,
  truncateToolResult,
  loadPermissions,
  persistAlwaysAllow,
  SAFE_TOOLS,
  type PermDecision,
} from "../permissions/index.js";
import { exec, spawnSync } from "child_process";
import { appendFileSync, readFileSync, writeFileSync, unlinkSync, readdirSync, existsSync, mkdirSync } from "node:fs";
import { join, relative, resolve } from "node:path";
import { homedir, tmpdir } from "node:os";

// ─── Types ────────────────────────────────────────────────────────────────────

type REPLState = "idle" | "thinking" | "streaming" | "tool" | "permission";

interface LastMetadata {
  metadata: KlaatAIMetadata;
  cost:     string;
  usage:    { prompt_tokens: number; completion_tokens: number; total_tokens: number };
}

interface PermRequest {
  tool:    string;
  summary: string;
  resolve: (d: PermDecision) => void;
  diff?:   DiffLine[];
  diffPath?: string;
}

interface ChatMessage {
  role:    "user" | "assistant" | "system" | "tool";
  content: string;
  thinking?: string;
  /** Thinking block collapse state — undefined/true = collapsed (default). */
  thinkingCollapsed?: boolean;
  toolName?:   string;
  toolSummary?: string;
  kind?: "error";
  model?: string;
  tier?: string;
  elapsed?: number;
  /** Tier-clamp note when the server overrode the hint: "heavy → code". */
  clamp?: { from: string; to: string; why?: string };
  collapsed?: boolean;
  /** Display-only unified diff for edit/write tools (not sent to the model). */
  diff?: DiffLine[];
  diffPath?: string;
}

interface FileChange {
  path:      string;
  additions: number;
  deletions: number;
}

// ─── Constants ────────────────────────────────────────────────────────────────

// ─── Helpers ──────────────────────────────────────────────────────────────────

/**
 * Parse a tier clamp out of x_klaatai.reason. The server marks an overridden
 * hint as `hint_clamped:heavy->code(plan:free)` (E4 public protocol). Returns
 * null when the served tier matched the request (no clamp to show).
 */
function parseClamp(reason?: string): { from: string; to: string; why?: string } | null {
  if (!reason) return null;
  const m = reason.match(/hint_clamped:(\w+)->(\w+)(?:\(([^)]*)\))?/);
  if (!m || m[1] === m[2]) return null;
  return { from: m[1]!, to: m[2]!, why: m[3] };
}

// Rotating status verbs — one step every 3s of elapsed time.
const THINKING_VERBS = [
  "Thinking", "Pondering", "Scheming", "Brewing", "Mulling", "Conjuring",
  "Deliberating", "Percolating", "Noodling", "Crunching", "Weaving", "Cooking",
];
const WRITING_VERBS = ["Writing", "Composing", "Generating", "Drafting"];

// Placeholder tips — rotate while the input is empty so features get discovered.
const PLACEHOLDER_TIPS = [
  'Ask anything… "Fix the TODO in main.ts"',
  'Try "@" to reference a file',
  'Try "!" to run a shell command',
  "Ctrl+P — command palette · /help — all commands",
  '"/agents" — parallel sub-agents · "/model" — routing tier',
  '"/review" — AI code review of your git diff',
  "Ctrl+R — search input history",
];

// Syntax-highlight a shell command into colored spans for the permission card.
function highlightCommand(cmd: string, maxW: number): Span[] {
  const parts = cmd.split(/(\s+)/);
  const spans: Span[] = [];
  let isFirst = true;
  let totalW = 0;

  for (const part of parts) {
    if (totalW >= maxW) break;
    if (/^\s+$/.test(part)) {
      spans.push(span(part, {}));
      totalW += part.length;
      continue;
    }
    let fg: number | string;
    if (isFirst) {
      fg = 114; // green — command name
      isFirst = false;
    } else if (part.startsWith("-")) {
      fg = 222; // yellow — flags
    } else if (part.startsWith("/") || part.startsWith("~") || part.startsWith("./") || part.includes("/")) {
      fg = 81; // cyan — paths
    } else if (part.startsWith("http://") || part.startsWith("https://")) {
      fg = 81; // cyan — URLs
    } else if (/^[0-9]+$/.test(part)) {
      fg = 176; // purple — numbers
    } else if (part.startsWith("$") || part.startsWith("\"") || part.startsWith("'")) {
      fg = 215; // orange — variables/strings
    } else {
      fg = 252; // default light
    }
    const display = totalW + part.length > maxW ? part.slice(0, maxW - totalW - 1) + "…" : part;
    spans.push(span(display, { fg }));
    totalW += display.length;
  }
  return spans;
}

// Syntax-highlight a file path: directory parts dim, filename bright.
function highlightPath(filePath: string, maxW: number): Span[] {
  const truncated = filePath.length > maxW ? "…" + filePath.slice(filePath.length - maxW + 1) : filePath;
  const lastSlash = truncated.lastIndexOf("/");
  if (lastSlash < 0) return [span(truncated, { fg: "white", bold: true })];
  return [
    span(truncated.slice(0, lastSlash + 1), { fg: 245 }),
    span(truncated.slice(lastSlash + 1), { fg: "white", bold: true }),
  ];
}

// Right-side tips below input — short actionable hints, rotate every 8s.
const META_TIPS = [
  "tip: @ to attach files",
  "tip: /compact to free context",
  "tip: Ctrl+B toggle sidebar",
  "tip: /tier heavy for complex tasks",
  "tip: /clear to reset session",
  "tip: /cost to see usage stats",
  "tip: /theme to change colors",
  "tip: /undo to revert last edit",
];

// ─── runREPL ──────────────────────────────────────────────────────────────────

export async function runREPL(
  app:         App,
  client:      KlaatAIClient,
  config:      Config,
  projectRoot: string,
  opts:        { theme?: Theme; resumeId?: string } = {},
): Promise<{ sessionId: string }> {

  // ─── Widgets ──────────────────────────────────────────────────────────────
  const field   = new InputField();
  const chatSV  = new ScrollView();
  const spinner = new Spinner(SPINNER_DOTS, 80);
  const pulse   = new PulseBar();
  const tabs    = new TabBar(["Build", "Plan"]);
  const dialog  = new DialogManager();
  const hitGrid = new HitGrid();

  dialog.setRenderCallback(() => app.requestRender());

  // ─── State ────────────────────────────────────────────────────────────────
  let replState:    REPLState          = "idle";
  let apiMessages:  Message[]          = [];
  let streamBuffer: string             = "";
  let streamRevealLen = 0;             // typing effect: chars revealed so far
  let streamRevealDone = false;        // true once reveal catches up or threshold passed
  let streamRevealTimer: ReturnType<typeof setInterval> | null = null;
  let lastActiveFile = "";             // breadcrumb: last file the AI touched
  let lastActiveFileTime = 0;          // timestamp when set (clears after 15s idle)
  let interrupted = false;             // set by Escape to break the outer tool loop
  let lastMeta:     LastMetadata | null = null;
  let sessionCost:  number             = 0;
  let permRequest:  PermRequest | null  = null;
  let permSelected = 0; // arrow-key focused button index (0=Yes 1=No 2=Session 3=Always)

  // ─── ask_user picker (model asks the user a multiple-choice question) ─────
  interface AskRequest {
    question: string;
    options: string[];
    multi: boolean;
    cursor: number;
    selected: Set<number>;
    resolve: (answer: string) => void;
  }
  let askRequest: AskRequest | null = null;

  function requestUserAnswer(question: string, options: string[], multi: boolean): Promise<string> {
    return new Promise((resolve) => {
      askRequest = { question, options, multi, cursor: 0, selected: new Set(), resolve };
      replState = "permission";
      app.requestRender();
    });
  }

  // ─── Theme picker (interactive selector with live preview) ─────────────────
  let themePicker: { cursor: number } | null = null;

  let totalTokens:  { prompt: number; completion: number } = { prompt: 0, completion: 0 };
  let lastContextSize: number = 0; // actual context size from last API call (prompt_tokens)

  // ─── 9.4 budget guards ─────────────────────────────────────────────────────
  const sessionStart = Date.now();
  /** Per-response cost events for burn-rate calculation (bounded). */
  let costEvents: { t: number; cost: number }[] = [];
  /** Cost attributed to the current user task (between user messages). */
  let currentTaskCost = 0;
  let currentTaskLabel: string | null = null;
  const taskCostLog: { label: string; cost: number }[] = [];
  let lastBurnWarnAt = 0;
  /** Set when config.maxSessionCost is crossed — stops further agent rounds
   * this turn; each new user message re-arms exactly one more round. */
  let budgetStop = false;
  /** Consecutive doom-loop refusal rounds (breaks the loop at 3). */
  let loopRefusals = 0;

  // ─── 9.5 per-phase token budgets (logic in agent/phase-budget.ts) ──────────
  const phaseTracker = new PhaseTracker({ enabled: config.phaseBudgets !== "off" });

  /** Attribute usage + budget check; called from the metadata handler. */
  function checkPhaseBudget(totalTokensThisTurn: number): void {
    const ev = phaseTracker.addUsage(totalTokensThisTurn);
    if (!ev) return;
    if (ev.kind === "pause") {
      messages.push({
        role: "system", kind: "error",
        content:
          `⛔ Exploration used ${formatTok(ev.used)} tokens without producing an edit ` +
          `or answer (budget ${formatTok(ev.budget)}). Paused — the agent may be stuck. ` +
          `Narrow the task, point it at specific files, or send "continue" to allow more exploration.`,
      });
    } else {
      messages.push({
        role: "system",
        content:
          `⚠ The ${ev.phase} phase passed its soft token budget ` +
          `(${formatTok(ev.used)} / ${formatTok(ev.budget)}). See /cost for the phase breakdown.`,
      });
    }
    chatLinesDirty = true;
  }

  function recordTurnCost(cost: number): void {
    costEvents.push({ t: Date.now(), cost });
    currentTaskCost += cost;
    if (costEvents.length > 500) costEvents = costEvents.slice(-500);
  }

  /** $ spent in the trailing window, normalized to per-minute. */
  function burnRatePerMin(windowMs = 60_000): number {
    const cutoff = Date.now() - windowMs;
    return costEvents.filter(e => e.t >= cutoff).reduce((s, e) => s + e.cost, 0) * (60_000 / windowMs);
  }

  function sessionAvgPerMin(): number {
    return sessionCost / Math.max(1, (Date.now() - sessionStart) / 60_000);
  }

  /** Burn-rate + hard-cap checks; called after every usage report. */
  function checkBudgetGuards(): void {
    const cap = config.maxSessionCost;
    if (cap && cap > 0 && sessionCost >= cap && !budgetStop) {
      budgetStop = true;
      messages.push({
        role: "system", kind: "error",
        content:
          `⛔ Session cost $${sessionCost.toFixed(4)} reached the maxSessionCost cap ($${cap.toFixed(2)}). ` +
          `Agent rounds paused — send a message to continue one round at a time, or raise/remove ` +
          `maxSessionCost in ~/.klaatai/config.json.`,
      });
      chatLinesDirty = true;
      return;
    }
    // Spend-rate anomaly: current burn > 3× session average. Only meaningful
    // once the session has history and real spend.
    const now = Date.now();
    if (now - sessionStart > 3 * 60_000 && sessionCost > 0.02 && now - lastBurnWarnAt > 5 * 60_000) {
      const burn = burnRatePerMin();
      const avg = sessionAvgPerMin();
      if (avg > 0 && burn > 3 * avg) {
        lastBurnWarnAt = now;
        messages.push({
          role: "system",
          content:
            `⚠ Burn rate $${burn.toFixed(4)}/min is ${(burn / avg).toFixed(1)}× the session average ` +
            `($${avg.toFixed(4)}/min). Check /cost — a loop or an oversized context may be burning budget.`,
        });
        chatLinesDirty = true;
      }
    }
  }
  let forceTier:    string | null      = null;
  // Active third-party model name (null = Klaatu). See /model; config.customModels.
  let activeCustomModel: string | null = null;
  // Live slash-command suggestions shown above the input while typing "/…".
  let slashSuggest: { items: { cmd: string; desc: string }[]; selected: number } | null = null;
  let history:      string[]           = [];
  let elapsed:      number             = 0;
  let elapsedTimer: ReturnType<typeof setInterval> | null = null;
  let lastModel:    string             = "Auto";
  let lastTier:     string             = "smart";
  // Tier-aware toolset dialect (8.1). Custom endpoints and the config kill
  // switch always get the full set; otherwise pinned tier > last served tier.
  const activeDialect = (tier?: string | null): ToolDialect =>
    (config.toolDialects === "off" || client.customEndpoint)
      ? "full"
      : dialectForTier(tier ?? forceTier ?? lastTier);
  let lastClamp:    { from: string; to: string; why?: string } | null = null;
  let lastQuota:    QuotaSnapshot | null = null;
  let totalRequests = 0;
  let filesExpanded = true;
  let sidebarOverride: boolean | null  = null; // null = auto-detect from terminal width
  let ctrlXPressed  = false; // leader key for ctrl+x ctrl+e (external editor)

  // ─── Graph indexer state ──────────────────────────────────────────────────
  let graphStatus: string = "";  // shown in status bar during indexing
  // Live code-graph stats for the sidebar (from indexer progress + local DB).
  let graphStats: {
    indexing: boolean; indexed: number; total: number;
    files: number; symbols: number; edges: number; embedded: number;
  } | null = null;

  // ─── Vim keybindings state ────────────────────────────────────────────────
  let vimMode    = config.vimMode ?? false; // vim-style key bindings enabled
  let vimInsert  = true;  // true = INSERT mode, false = NORMAL mode
  let vimPendingD = false; // next key completes a 'd' motion (dd/dw/d$)
  let vimPendingG = false; // next key completes a 'g' motion (gg)
  let vimYank = ""; // last deleted text for p/P (unnamed register)

  /** Capture text removed by a field edit (before → after) into the vim yank slot. */
  const yankDeleted = (before: string) => {
    const after = field.value;
    if (before.length <= after.length) return;
    if (after.length === 0) {
      vimYank = before;
      return;
    }
    let i = 0;
    while (i < after.length && before[i] === after[i]) i++;
    vimYank = before.slice(i, i + (before.length - after.length));
  };

  // ─── Routing analytics — per-tier request counts for the session ──────────
  const tierCounts: Map<string, number> = new Map();

  // ─── Checkpoints — lightweight project snapshots ──────────────────────────
  interface Checkpoint { id: string; label: string; timestamp: number; files: Record<string, string>; }
  const checkpoints: Checkpoint[] = [];

  // ─── Undo tracking — stack of file-path arrays written per AI response ────
  /** Each entry = set of abs paths written during one AI response turn. */
  const undoStack: string[][] = [];
  /** Collects writes during the current AI response; committed to undoStack on done. */
  let currentResponseWrites: string[] = [];

  // ─── Tab mode prompts (Build vs Plan) — inserted after the system seed ────
  const TAB_SYSTEM_PROMPTS: Record<string, string> = MODE_PROMPTS;

  // ─── Plan mode ─────────────────────────────────────────────────────────────
  // In Plan mode the model gets only read-only tools + exit_plan_mode. It
  // researches, then calls exit_plan_mode with a plan; on approval we switch
  // to Build and it implements with the full toolset.
  const PLAN_READONLY_TOOLS = new Set([
    "read_file", "list_dir", "glob", "grep",
    "file_outline", "project_graph_query", "project_semantic_search", "impact_check",
    "web_fetch", "web_search", "todo_read", "todo_write", "ask_user",
    "delegate_task", // gated to read-only personas already
  ]);
  const EXIT_PLAN_TOOL: ToolDefinition = {
    type: "function",
    function: {
      name: "exit_plan_mode",
      description:
        "Call when your plan is ready. Presents the plan to the user; on approval the session " +
        "switches to Build mode so you can implement it. Use ONLY in Plan mode, after research.",
      parameters: {
        type: "object",
        properties: {
          plan: { type: "string", description: "The implementation plan in markdown: steps, files to touch, risks." },
        },
        required: ["plan"],
      },
    },
  };
  /** Set when exit_plan_mode fires mid-turn; consumed after the tool loop. */
  let pendingPlanExit: string | null = null;

  // ─── Active theme (can be changed at runtime via /theme) ──────────────────
  let activeTheme: Theme = (THEME_NAMES.includes(config.theme as Theme)
    ? config.theme as Theme
    : opts.theme ?? "dark");
  let palette = getPalette(activeTheme);

  // ─── Pending image attachments (pasted image file paths) ──────────────────
  /** Images the user pasted — attached to the next outgoing message. */
  interface PendingImage { path: string; b64: string; mime: string; }
  let pendingImages: PendingImage[] = [];

  // ─── Collapsed pastes ──────────────────────────────────────────────────────
  // Large multi-line pastes are shown as a compact chip in the input
  // (e.g. "[#1 42 lines pasted]") and expanded back to full text on submit.
  const pasteStore = new Map<number, string>();
  let pasteCounter = 0;
  const PASTE_LINE_THRESHOLD = 6;
  const pasteChipRe = /\[#(\d+) (\d+) lines pasted\]/g;

  /** Replace paste chips in `text` with their stored full content. */
  function expandPastes(text: string): string {
    return text.replace(pasteChipRe, (m, id) => pasteStore.get(Number(id)) ?? m);
  }

  // Lifetime usage — fetched from /v1/me/usage on startup, refreshed each request
  let lifetimeStats: LifetimeUsageStats | null = null;
  let lifetimeStatsAge: number = 0; // seconds since last fetch
  const DEFAULT_CONTEXT_WINDOW = 200_000;
  function getContextWindow(): number {
    const tier = forceTier ?? lastTier;
    return TIER_CONTEXT_WINDOW[tier] ?? DEFAULT_CONTEXT_WINDOW;
  }

  const sessionApproved = new Set<string>();

  // ─── Chat line cache — declared early so MCPManager callback can set dirty ──
  let chatLinesDirty = true;
  let chatAutoScroll = true;

  // ─── MCP Manager ──────────────────────────────────────────────────────────
  const mcpManager = new MCPManager(() => {
    // Called whenever any MCP server changes status — re-render sidebar
    chatLinesDirty = true;
    app.requestRender();
  });
  const mcpConfig = loadMCPConfig(projectRoot, {
    importMcpConfigs: config.compat?.importMcpConfigs !== false,
    onLog: (msg: string) => { process.stderr.write(msg + "\n"); },
  });
  if (Object.keys(mcpConfig.servers).length > 0) {
    mcpManager.connect(mcpConfig);
  }

  // ─── Plugins (user tools from ~/.klaatai/plugins + .klaatai/tools) ────────
  const pluginRegistry = new PluginRegistry();
  void pluginRegistry.load(projectRoot).then(() => {
    if (pluginRegistry.plugins.length > 0 || pluginRegistry.errors.length > 0) {
      app.requestRender();
    }
  });

  // ─── Lifetime usage fetch ─────────────────────────────────────────────────

  async function fetchLifetimeStats(): Promise<void> {
    const stats = await client.getUsageStats();
    if (stats) {
      lifetimeStats    = stats;
      lifetimeStatsAge = 0;
      chatLinesDirty   = true;
      app.requestRender();
    }
  }

  // ─── External editor compose (ctrl+x ctrl+e) ─────────────────────────────

  async function openExternalEditor(): Promise<void> {
    const editor = process.env["VISUAL"] || process.env["EDITOR"] || "vi";
    const tmpFile = join(tmpdir(), `klaatai-compose-${Date.now()}.md`);
    const current = field.value;

    try {
      writeFileSync(tmpFile, current, "utf-8");

      // Temporarily suspend the TUI: exit alt screen and restore normal terminal
      disableBracketedPaste();
      disableKitty();
      disableMouse();
      exitAltScreen();
      showCursor();
      setRawMode(false);

      // Blocking editor invocation
      spawnSync(editor, [tmpFile], { stdio: "inherit" });

      // Re-enter TUI
      setRawMode(true);
      enterAltScreen();
      hideCursor();
      clearScreen();
      enableMouse();
      enableKitty();
      enableBracketedPaste();

      // Load edited content back into field
      try {
        const newContent = readFileSync(tmpFile, "utf-8").replace(/\n$/, "");
        field.value = newContent;
        chatLinesDirty = true;
      } catch { /* keep existing field value */ }

    } catch (err) {
      // If anything goes wrong re-entering, show a system message
      pushSystemMsg(`External editor error: ${err instanceof Error ? err.message : String(err)}`, "error");
    } finally {
      try { unlinkSync(tmpFile); } catch { /* ignore */ }
      app.requestRender();
    }
  }

  // ─── @ file picker ────────────────────────────────────────────────────────

  type BunGlobCtor = new (pattern: string) => { scanSync(opts: { cwd: string; onlyFiles: boolean }): Iterable<string> };

  function listProjectFiles(root: string, maxResults = 2000): string[] {
    const EXCLUDE = new Set(["node_modules", ".git", "dist", "build", ".next", ".nuxt", "coverage", "__pycache__"]);
    const CODE_EXTS = new Set([".ts", ".tsx", ".js", ".jsx", ".mjs", ".cjs",
      ".py", ".go", ".rs", ".java", ".c", ".cpp", ".h", ".cs", ".rb",
      ".json", ".yaml", ".yml", ".toml", ".md", ".txt", ".sh",
      ".sql", ".graphql", ".html", ".css", ".scss", ".vue", ".svelte"]);

    try {
      const BunGlob = (globalThis as Record<string, unknown>)["Bun"] as { Glob: BunGlobCtor } | undefined;
      if (BunGlob?.Glob) {
        const g = new BunGlob.Glob("**/*");
        const all = Array.from(g.scanSync({ cwd: root, onlyFiles: true }))
          .filter(f => {
            const parts = f.split("/");
            if (parts.some(p => EXCLUDE.has(p))) return false;
            const dot = f.lastIndexOf(".");
            if (dot === -1) return false;
            return CODE_EXTS.has(f.slice(dot));
          })
          // Shallow paths first — top-level files are the likeliest @-targets.
          .sort((a, b) => {
            const da = a.split("/").length, db = b.split("/").length;
            return da !== db ? da - db : a.localeCompare(b);
          });
        return all.slice(0, maxResults);
      }
    } catch { /* fall through to find */ }

    // Fallback: use find command
    const excludeNames = [...EXCLUDE];
    const pruneArgs: string[] = [];
    for (let i = 0; i < excludeNames.length; i++) {
      if (i > 0) pruneArgs.push("-o");
      pruneArgs.push("-name", excludeNames[i]!, "-prune");
    }
    const result = spawnSync(
      "find",
      [root, "(", ...pruneArgs, ")", "-o", "-type", "f", "-print"],
      { encoding: "utf-8", timeout: 5000 },
    );
    if (result.status !== 0 || !result.stdout) return [];
    return result.stdout.trim().split("\n")
      .filter(f => { const dot = f.lastIndexOf("."); return dot !== -1 && CODE_EXTS.has(f.slice(dot)); })
      .map(f => relative(root, f))
      .sort()
      .slice(0, maxResults);
  }

  function openFilePicker(): void {
    const files = listProjectFiles(projectRoot);
    if (files.length === 0) {
      // No files found — just insert @
      field.paste("@");
      app.requestRender();
      return;
    }
    const items = files.map(f => ({ label: f, value: f, description: "" }));
    dialog.showList("Insert @ File Reference", items, (item) => {
      field.paste("@" + item.value + " ");
      chatLinesDirty = true;
      app.requestRender();
    }, () => {
      // Dismissed — insert bare @
      field.paste("@");
      app.requestRender();
    });
    app.requestRender();
  }

  // ─── Slash-command autocomplete ─────────────────────────────────────────────

  const SLASH_COMMANDS: { cmd: string; desc: string }[] = [
    { cmd: "/agents",     desc: "List agent personas + running/background agents" },
    { cmd: "/checkpoint", desc: "Snapshot modified files for rollback" },
    { cmd: "/clear",      desc: "Clear conversation" },
    { cmd: "/commit",     desc: "AI commit message + commit" },
    { cmd: "/compact",    desc: "Summarize context to free token window" },
    { cmd: "/cost",       desc: "Session cost + quota + context usage" },
    { cmd: "/context",    desc: "What's in the context window vs compacted away" },
    { cmd: "/diff",       desc: "Git diff (optionally one file)" },
    { cmd: "/doctor",     desc: "Diagnostics: auth, API, MCP, tools, config" },
    { cmd: "/exit",       desc: "Quit KLAAT CODE" },
    { cmd: "/help",       desc: "Show all commands and shortcuts" },
    { cmd: "/hooks",      desc: "List configured lifecycle hooks" },
    { cmd: "/init",       desc: "Analyse project → .klaatai/rules.md" },
    { cmd: "/logout",     desc: "Sign out and clear stored credentials" },
    { cmd: "/mcp",        desc: "MCP servers: list / enable / add / disable" },
    { cmd: "/model",      desc: "Pick model: Klaatu or custom third-party API" },
    { cmd: "/perms",      desc: "Show permission rules" },
    { cmd: "/plugin",     desc: "List / reload plugins" },
    { cmd: "/resume",     desc: "Resume a saved session" },
    { cmd: "/review",     desc: "AI code review of current git diff" },
    { cmd: "/rollback",   desc: "Restore files from a checkpoint" },
    { cmd: "/sessions",   desc: "List saved sessions" },
    { cmd: "/export",     desc: "Export session to Markdown [path]" },
    { cmd: "/share",      desc: "Alias for /export" },
    { cmd: "/skill",      desc: "Invoke a saved prompt skill" },
    { cmd: "/test",       desc: "Run the project test suite" },
    { cmd: "/theme",      desc: "Show or change the UI theme" },
    { cmd: "/tier",       desc: "Lock a Klaatu routing tier (smart to reset)" },
    { cmd: "/undo",       desc: "Revert files written by last response" },
    { cmd: "/vimmode",    desc: "Toggle vim key bindings" },
    { cmd: "/why",        desc: "Explain last routing decision" },
  ];

  /** Recompute the suggestion strip from the current input value. */
  function updateSlashSuggest(): void {
    if (replState !== "idle" || permRequest || dialog.active || themePicker || askRequest) {
      slashSuggest = null;
      return;
    }
    const v = field.value;
    // Only while typing the command token itself: "/", "/mo" — not "/model x".
    if (!v.startsWith("/") || /[\s\n]/.test(v)) { slashSuggest = null; return; }
    const q = v.slice(1);
    const scored = SLASH_COMMANDS
      .map(c => ({ c, s: q ? fuzzyScore(q, c.cmd.slice(1)) : 0 }))
      .filter(x => x.s >= 0)
      .sort((a, b) => b.s - a.s || a.c.cmd.localeCompare(b.c.cmd))
      .slice(0, 8)
      .map(x => x.c);
    const prev = slashSuggest;
    slashSuggest = scored.length ? { items: scored, selected: 0 } : null;
    // Keep the highlighted command stable across keystrokes when possible.
    if (slashSuggest && prev) {
      const keep = scored.findIndex(c => c.cmd === prev.items[prev.selected]?.cmd);
      if (keep >= 0) slashSuggest.selected = keep;
    }
  }

  // ─── Tier / model pickers (/tier, /model, ctrl+p) ──────────────────────────

  function openTierPicker(): void {
    dialog.showList("Select Klaatu Tier", [
      { label: "Auto (Smart Routing)", value: "smart",  description: "Server picks optimal tier per request", color: "cyan" },
      { label: "Klaatu Nano",          value: "nano",   description: "Fastest & cheapest",                   color: "white" },
      { label: "Klaatu Flash",         value: "fast",   description: "Balanced speed / cost",                color: "#34d399" },
      { label: "Klaatu Core",          value: "code",   description: "Code-optimised",                       color: "#60a5fa" },
      { label: "Klaatu Reason",        value: "reason", description: "Advanced reasoning",                   color: "#c084fc" },
      { label: "Klaatu Ultra",         value: "heavy",  description: "Most powerful",                        color: "#f87171" },
    ], (item) => {
      if (item.value === "smart") {
        forceTier = null;
        pushSystemMsg("Smart routing restored — server auto-selects tier per request.");
      } else {
        forceTier = item.value;
        const name = KLAATU_MODEL_MAP[item.value] ?? item.value;
        pushSystemMsg(`Routing tier locked to **${name}** (${item.value}).\nUse \`/tier smart\` to restore smart routing.`);
      }
    });
    app.requestRender();
  }

  function activateKlaatu(): void {
    activeCustomModel = null;
    client.setCustomEndpoint(null);
    pushSystemMsg("Model set to **Klaatu** — smart tier routing active. Use `/tier` to lock a tier.");
  }

  function activateCustomModel(name: string): boolean {
    const models = loadConfig().customModels ?? [];
    const m = models.find(x => x.name.toLowerCase() === name.toLowerCase());
    if (!m) {
      pushSystemMsg(
        `No custom model named "${name}".\n` +
        `Configured: ${models.map(x => x.name).join(", ") || "(none)"}\n` +
        `Add one: /model add <name> <base_url> <model_id> [env:API_KEY_VAR | key]`,
        "error",
      );
      return false;
    }
    const key = resolveCustomModelKey(m);
    if (!key) {
      pushSystemMsg(
        `Custom model "${m.name}" has no usable API key` +
        (m.apiKeyEnv ? ` — environment variable ${m.apiKeyEnv} is not set.` : " — set apiKey or apiKeyEnv in ~/.klaatai/config.json."),
        "error",
      );
      return false;
    }
    activeCustomModel = m.name;
    client.setCustomEndpoint({ name: m.name, baseUrl: m.baseUrl, model: m.model, apiKey: key });
    pushSystemMsg(
      `Model set to **${m.name}** (${m.model} @ ${m.baseUrl}).\n` +
      `Klaatu routing, quota and graph tools are bypassed for chat. \`/model klaatu\` to switch back.`,
    );
    return true;
  }

  function openModelPicker(): void {
    const models = loadConfig().customModels ?? [];
    const items = [
      {
        label: "Klaatu", value: "klaatu",
        description: activeCustomModel ? "Back to Klaatu smart routing" : "Active — smart tier routing",
        color: "cyan",
      },
      ...models.map(m => ({
        label: m.name, value: `custom:${m.name}`,
        description: `${m.model} @ ${m.baseUrl}${activeCustomModel === m.name ? "  (active)" : ""}`,
        color: activeCustomModel === m.name ? "#34d399" : "white",
      })),
    ];
    dialog.showList("Select Model", items, (item) => {
      if (item.value === "klaatu") activateKlaatu();
      else activateCustomModel(item.value.slice("custom:".length));
    });
    app.requestRender();
  }

  // ─── Session persistence ──────────────────────────────────────────────────

  const SESSION_DIR = join(homedir(), ".klaatai", "sessions");
  mkdirSync(SESSION_DIR, { recursive: true });

  const _sessionTs  = new Date().toISOString().slice(0, 19).replace(/:/g, "-");
  const _sessionRnd = Math.random().toString(36).slice(2, 6);
  const sessionId   = `${_sessionTs}-${_sessionRnd}`;
  const sessionFile = join(SESSION_DIR, `${sessionId}.jsonl`);
  const ledger      = new SessionLedger(join(SESSION_DIR, `${sessionId}.ledger.md`));

  function appendSessionMsg(msg: ChatMessage): void {
    try {
      appendFileSync(sessionFile, JSON.stringify(msg) + "\n", "utf-8");
    } catch { /* ignore write errors */ }
  }

  interface SessionEntry {
    id: string; file: string; date: string; preview: string;
  }

  function getSessionList(): SessionEntry[] {
    try {
      return readdirSync(SESSION_DIR)
        .filter(f => f.endsWith(".jsonl"))
        .sort().reverse().slice(0, 30)
        .map(f => {
          const id   = f.replace(".jsonl", "");
          const file = join(SESSION_DIR, f);
          try {
            const lines = readFileSync(file, "utf-8").trim().split("\n").filter(Boolean);
            const firstUser = lines.map(l => JSON.parse(l) as ChatMessage).find(m => m.role === "user");
            const preview = (firstUser?.content ?? "(empty)").slice(0, 60);
            const date = id.slice(0, 19).replace("T", " ").replace(/-/g, (_, i) => i < 10 ? "-" : ":");
            return { id, file, date, preview };
          } catch {
            return { id, file, date: id.slice(0, 19), preview: "(unreadable)" };
          }
        });
    } catch { return []; }
  }

  function loadSessionFromFile(file: string): { msgs: ChatMessage[]; apiMsgs: Message[] } {
    try {
      const lines = readFileSync(file, "utf-8").trim().split("\n").filter(Boolean);
      const msgs  = lines.map(l => JSON.parse(l) as ChatMessage);
      const apiMsgs: Message[] = [];
      for (const m of msgs) {
        if (m.role === "user")
          apiMsgs.push({ role: "user", content: m.content });
        else if (m.role === "assistant" && m.kind !== "error")
          apiMsgs.push({ role: "assistant", content: m.content });
      }
      return { msgs, apiMsgs };
    } catch { return { msgs: [], apiMsgs: [] }; }
  }

  // Transcript starts empty — the welcome banner is rendered as the empty
  // state directly in rebuildChatLines (no separate onboarding screen).
  const messages: ChatMessage[] = [];
  const _welcomeEmail = loadCredentials().email;
  const userLabel = _welcomeEmail ? _welcomeEmail.split("@")[0] : undefined;
  const hasProjectRules =
    existsSync(join(projectRoot, ".klaatai", "rules.md")) ||
    existsSync(join(projectRoot, "AGENTS.md")) ||
    existsSync(join(projectRoot, "CLAUDE.md"));

  // ─── Agent system prompt seed (core + environment + project rules) ────────
  apiMessages.push(...seedSystemMessages(projectRoot, ledger.path));

  // Write sandbox — confine edits/writes to the project unless configured off.
  configureSandbox({
    enabled: config.sandbox !== "off",
    root: projectRoot,
    allow: [join(homedir(), ".klaatai"), ...(config.sandboxAllow ?? [])],
  });

  // Post-edit diagnostics feedback loop.
  configureDiagnostics({
    enabled: config.diagnostics !== "off",
    commands: config.diagnosticsCommands,
  });

  // 9.1: tool-output noise filter (progress bars, passing-test spam, dupes).
  setOutputFilterEnabled(config.outputFilter !== "off");

  // 9.3: attention-ordered old-context arrangement, config-gated.
  const compactOpts = (): { attentionOrder: boolean } =>
    ({ attentionOrder: config.attentionOrder !== "off" });

  const modifiedFiles: FileChange[] = [];

  // ─── Chat line cache ──────────────────────────────────────────────────────
  let cachedChatLines: StyledLine[] = [];
  // chatLinesDirty and chatAutoScroll declared above (before MCPManager) to avoid TDZ
  /** Maps a chat line index → message array index (for tool toggle clicks). */
  let toolLineToMsgIdx: Map<number, number> = new Map();
  /** Maps a chat line index → message array index (for thinking toggle clicks). */
  let thinkLineToMsgIdx: Map<number, number> = new Map();
  /** Cached layout info for mouse hit-testing */
  let lastChatInnerY = 0;
  let lastScrollTop = 0;
  /** Mouse-drag selection state */
  let mouseSelStartY: number | null = null;
  let mouseCurrentY: number | null  = null;
  /** Track pointer cursor state for clickable regions */
  let lastPointerIsHand = false;
  /** Last render rect of the input field + whether a drag-select is on it. */
  let lastFieldRect: { x: number; y: number; width: number; height: number } | null = null;
  let inputSelecting = false;

  // ─── Clipboard helpers ────────────────────────────────────────────────────

  /** Write text to the system clipboard cross-platform. Returns true on success. */
  function copyToClipboard(text: string): boolean {
    try {
      if (process.platform === "darwin") {
        spawnSync("pbcopy", [], { input: text, encoding: "utf-8" });
      } else if (process.platform === "win32") {
        spawnSync("clip", [], { input: text, encoding: "utf-8", shell: true });
      } else {
        const r = spawnSync("xclip", ["-selection", "clipboard"], { input: text, encoding: "utf-8" });
        if (r.error) spawnSync("xsel", ["--clipboard", "--input"], { input: text, encoding: "utf-8" });
      }
      return true;
    } catch { return false; }
  }

  /** Convert StyledLine[] to plain text (strip all styling). */
  function styledLinesToText(lines: StyledLine[]): string {
    return lines.map(line => line.map(s => s.text).join("")).join("\n");
  }

  // ─── Markdown theme — derived from palette, rebuilt on theme change ──────
  // Defined as a let so /theme can update it by setting chatLinesDirty=true;
  // rebuildChatLines() reads this each time it runs.
  function buildMdTheme() {
    return {
      heading:    palette.headingFg as ("white" | number),
      bold:       palette.headingFg as ("white" | number),
      italic:     palette.mutedFg + 7,
      code:       palette.codeFg,
      codeBg:     palette.codeBg,
      codeBlock:  palette.chatFg,
      blockBg:    palette.codeBg,
      link:       75,
      linkUrl:    palette.mutedFg,
      bullet:     palette.chatFg,
      hr:         palette.mutedFg - 5,
      text:       palette.chatFg,
      dimText:    palette.mutedFg,
      thinking:   palette.mutedFg - 2,
      thinkingBg: null as null,
    };
  }

  let cachedMessageLines: StyledLine[] = [];
  let cachedStreamLines: StyledLine[] = [];

  function rebuildChatLines(width: number): StyledLine[] {
    const streamActive = !!(streamBuffer && (replState === "streaming" || replState === "thinking"));

    // Fast path: only the stream portion changed (typing reveal, new tokens)
    if (!chatLinesDirty && streamActive && cachedMessageLines.length > 0) {
      const mdTheme = buildMdTheme();
      const contentW = Math.max(10, width);
      const visibleStream = streamRevealDone ? streamBuffer : streamBuffer.slice(0, streamRevealLen);
      const newStreamLines: StyledLine[] = [[]];
      const routingMode = config.routingDisplay ?? "minimal";
      const streamTier  = forceTier ?? lastTier;
      const streamTierColor = (TIER_COLOR_MAP as Record<string, number | string>)[streamTier] ?? palette.assistantFg;
      const klaatModel  = activeCustomModel ?? (KLAATU_MODEL_MAP[streamTier] ?? "Klaatu Auto");
      const elapsed0    = elapsed > 0 ? formatElapsed(elapsed) : spinner.frame;
      if (routingMode === "off") {
        newStreamLines.push([span(spinner.frame, { fg: palette.mutedFg })]);
      } else {
        newStreamLines.push([
          span("✦ ", { fg: palette.assistantFg, bold: true }),
          span(tabs.activeTab.label, { fg: palette.chatFg as number | "white", bold: true }),
          span("  ·  ", { fg: palette.mutedFg - 3 }),
          span(klaatModel, { fg: streamTierColor as number, bold: true }),
          span("  ·  ", { fg: palette.mutedFg - 3 }),
          span(elapsed0, { fg: palette.mutedFg }),
        ]);
      }
      const mdLines = renderMarkdown(visibleStream + "▌", contentW - 2, mdTheme)
        .map(l => (l.length > 0 ? [span("  "), ...l] : l));
      newStreamLines.push(...mdLines);
      newStreamLines.push([]);
      cachedStreamLines = newStreamLines;
      cachedChatLines = [...cachedMessageLines, ...cachedStreamLines];
      return cachedChatLines;
    }

    if (!chatLinesDirty && cachedChatLines.length > 0) return cachedChatLines;

    const mdTheme = buildMdTheme();
    const lines: StyledLine[] = [];
    const contentW = Math.max(10, width);
    toolLineToMsgIdx = new Map();
    thinkLineToMsgIdx = new Map();

    // Empty state renders a full-height welcome card directly in render()
    // (see drawWelcomeCard); the transcript lines stay empty here.

    for (let mi = 0; mi < messages.length; mi++) {
      const msg = messages[mi]!;

      // ── Role header (OpenCode-style: ■ Agent · Model · elapsed) ─────
      if (msg.role === "user") {
        lines.push([]);
        lines.push([
          span("❯ ", { fg: 133, bold: true }),
          span("You", { fg: palette.userFg, bold: true }),
        ]);
      } else if (msg.role === "assistant") {
        lines.push([]);
        if (msg.kind === "error") {
          lines.push([
            span("✖ ", { fg: 204, bold: true }),
            span("Error", { fg: 204, bold: true }),
          ]);
        } else {
          const routingMode = config.routingDisplay ?? "minimal";
          if (routingMode === "off") {
            // No header at all
          } else {
            const msgTier = msg.tier ?? lastTier;
            const msgTierColor = (TIER_COLOR_MAP as Record<string, number | string>)[msgTier] ?? palette.assistantFg;
            const msgModelName = KLAATU_MODEL_MAP[msgTier] ?? `Klaatu ${msgTier}`;
            const headerParts: StyledLine = [
              span("✦ ", { fg: palette.assistantFg, bold: true }),
              span(tabs.activeTab.label, { fg: palette.chatFg as number | "white", bold: true }),
              span("  ·  ", { fg: palette.mutedFg - 3 }),
              span(msgModelName, { fg: msgTierColor as number, bold: true }),
            ];
            if (msg.elapsed && msg.elapsed > 0) {
              headerParts.push(span("  ·  ", { fg: palette.mutedFg - 3 }));
              headerParts.push(span(formatElapsed(msg.elapsed), { fg: palette.mutedFg }));
            }
            // Tier-clamp badge: server overrode the requested tier hint.
            if (msg.clamp) {
              headerParts.push(span("  ", {}));
              headerParts.push(span(`⤵ ${msg.clamp.from}→${msg.clamp.to}`, { fg: 222, bold: true }));
              if (msg.clamp.why) headerParts.push(span(` (${msg.clamp.why})`, { fg: palette.mutedFg, italic: true }));
            }
            lines.push(headerParts);
          }
        }
      } else if (msg.role === "tool") {
        lines.push([]);
        // Tool header with collapse indicator
        const isCollapsed = msg.collapsed !== false;
        const contentLines = msg.content.split("\n").length;
        const isLong = contentLines > 6;

        // Header: collapse arrow · status icon · verb+target summary · size hint.
        // The summary already carries the verb (read/edit/$/grep …), so the raw
        // tool name only appears when no richer summary exists.
        const failed = msg.content.startsWith("Error");
        const label = msg.toolSummary && msg.toolSummary !== msg.toolName
          ? msg.toolSummary
          : (msg.toolName ?? "Tool");
        const toolHeader: StyledLine = [
          span(isLong ? (isCollapsed ? "▸ " : "▾ ") : "· ", { fg: 222, bold: true }),
          span(failed ? "✖ " : "✓ ", { fg: failed ? 204 : 114, bold: true }),
          span(label, { fg: palette.chatFg as number | "white", bold: true }),
        ];

        if (isLong && isCollapsed) {
          toolHeader.push(span("  ·  ", { fg: palette.mutedFg - 3 }));
          toolHeader.push(span(`${contentLines} lines`, { fg: palette.mutedFg }));
          toolHeader.push(span("  ⤢ expand", { fg: palette.mutedFg - 5, italic: true }));
        } else if (isLong) {
          toolHeader.push(span("  ·  ", { fg: palette.mutedFg - 3 }));
          toolHeader.push(span("⤡ collapse", { fg: palette.mutedFg - 5, italic: true }));
        }

        // Diff badge in the header (+adds / −dels)
        if (msg.diff && msg.diff.length > 0) {
          const st = diffStat(msg.diff);
          toolHeader.push(span("  ", {}));
          if (st.add) toolHeader.push(span(`+${st.add}`, { fg: 114, bold: true }));
          if (st.add && st.del) toolHeader.push(span(" ", {}));
          if (st.del) toolHeader.push(span(`-${st.del}`, { fg: 204, bold: true }));
        }

        if (isLong) toolLineToMsgIdx.set(lines.length, mi);
        lines.push(toolHeader);

        // ── Diff block (edit/write tools) — full-width GitHub-style rows ──
        if (msg.diff && msg.diff.length > 0) {
          const dw = contentW - 2;
          for (const d of msg.diff) lines.push([span("  "), ...diffRow(d, dw)]);
          lines.push([]);
          continue;
        }

        // Tool content — collapsed: framed 3-line peek; expanded: full body
        if (isLong && isCollapsed) {
          const preview = msg.content.split("\n").slice(0, 3);
          for (const pLine of preview) {
            lines.push([
              span("    │ ", { fg: palette.mutedFg - 5 }),
              span(pLine.slice(0, contentW - 8), { fg: palette.toolFg }),
            ]);
          }
          lines.push([span("    ╵ …", { fg: palette.mutedFg - 5, dim: true })]);
        } else {
          const mdLines = renderMarkdown(msg.content, contentW - 4, {
            ...mdTheme, text: palette.toolFg,
          }).map(l => (l.length > 0 ? [span("    "), ...l] : l));
          lines.push(...mdLines);
        }
        lines.push([]);
        continue;
      } else {
        lines.push([]);
      }

      // ── Thinking content (collapsible reasoning block, default closed) ──
      if (msg.thinking) {
        const thinkCollapsed = msg.thinkingCollapsed !== false;
        const nLines = msg.thinking.split("\n").length;
        thinkLineToMsgIdx.set(lines.length, mi);
        lines.push([
          span(thinkCollapsed ? "  ▸ " : "  ▾ ", { fg: palette.mutedFg, bold: true }),
          span("thinking", { fg: palette.mutedFg, italic: true }),
          span(`  ·  ${nLines} line${nLines === 1 ? "" : "s"}`, { fg: palette.mutedFg - 3 }),
          span(thinkCollapsed ? "  ⤢ expand" : "  ⤡ collapse", { fg: palette.mutedFg - 5, italic: true }),
        ]);
        if (!thinkCollapsed) {
          const thinkLines = renderMarkdown(msg.thinking, contentW - 4, {
            ...mdTheme, text: palette.mutedFg,
          }).map(l => (l.length > 0 ? [span("    "), ...l] : l));
          lines.push(...thinkLines);
        }
      }

      // ── Main content — indented under its role header ────────────────
      const indent = (ls: StyledLine[]): StyledLine[] =>
        ls.map(l => (l.length > 0 ? [span("  "), ...l] : l));
      if (msg.kind === "error") {
        const errorLines = renderMarkdown(msg.content, contentW - 2, {
          ...mdTheme, text: 204, bold: 204,
        });
        lines.push(...indent(errorLines));
      } else {
        const mdLines = renderMarkdown(msg.content, contentW - 2, mdTheme);
        lines.push(...(msg.role === "user" || msg.role === "assistant" ? indent(mdLines) : mdLines));
      }
      lines.push([]);
    }

    // Save message lines (expensive part) for fast-path reuse
    cachedMessageLines = [...lines];

    // ── Streaming partial response ────────────────────────────────────
    if (streamBuffer && (replState === "streaming" || replState === "thinking")) {
      lines.push([]);
      const routingMode = config.routingDisplay ?? "minimal";
      const streamTier  = forceTier ?? lastTier;
      const streamTierColor = (TIER_COLOR_MAP as Record<string, number | string>)[streamTier] ?? palette.assistantFg;
      const klaatModel  = activeCustomModel ?? (KLAATU_MODEL_MAP[streamTier] ?? "Klaatu Auto");
      const elapsed0    = elapsed > 0 ? formatElapsed(elapsed) : spinner.frame;
      let streamHeader: StyledLine;
      if (routingMode === "off") {
        streamHeader = [span(spinner.frame, { fg: palette.mutedFg })];
      } else {
        streamHeader = [
          span("✦ ", { fg: palette.assistantFg, bold: true }),
          span(tabs.activeTab.label, { fg: palette.chatFg as number | "white", bold: true }),
          span("  ·  ", { fg: palette.mutedFg - 3 }),
          span(klaatModel, { fg: streamTierColor as number, bold: true }),
          span("  ·  ", { fg: palette.mutedFg - 3 }),
          span(elapsed0, { fg: palette.mutedFg }),
        ];
      }
      lines.push(streamHeader);

      const visibleStream = streamRevealDone
        ? streamBuffer
        : streamBuffer.slice(0, streamRevealLen);
      const mdLines = renderMarkdown(visibleStream + "▌", contentW - 2, mdTheme)
        .map(l => (l.length > 0 ? [span("  "), ...l] : l));
      lines.push(...mdLines);
      lines.push([]);
    }

    cachedChatLines = lines;
    chatLinesDirty = false;
    return lines;
  }

  // ─── Timing ───────────────────────────────────────────────────────────────

  function startTimer(): void {
    if (elapsedTimer) return;
    const t0 = Date.now();
    elapsed = 0;
    elapsedTimer = setInterval(() => {
      elapsed = Math.floor((Date.now() - t0) / 1000);
      app.requestRender();
    }, 1000);
  }

  function stopTimer(): void {
    if (elapsedTimer) { clearInterval(elapsedTimer); elapsedTimer = null; }
    elapsed = 0;
  }

  // Idle tick — rotates the placeholder tip while the input sits empty.
  const tipTimer = setInterval(() => {
    if (replState === "idle" && !permRequest && field.value === "") {
      app.requestRender();
    }
  }, 6000);

  // ─── Permission handling ──────────────────────────────────────────────────

  function requestPermission(tc: ToolCall): Promise<PermDecision> {
    return new Promise((resolve) => {
      const d = diffForTool(tc);
      permRequest = {
        tool:    tc.function.name,
        summary: summarizeTool(tc),
        resolve,
        diff:    d?.diff,
        diffPath: d?.path,
      };
      permSelected = 0;
      replState = "permission";
      app.requestRender();
    });
  }

  function skillLoadOptions() {
    return {
      projectRoot,
      importClaudeSkills: config.compat?.importClaudeSkills !== false,
    };
  }

  // ─── Hooks ────────────────────────────────────────────────────────────────
  // v1 entry: a bare shell-command string (env vars only, can't block).
  // v2 entry: { command, matcher?, timeout? } — receives a JSON payload on
  // STDIN and, for before_tool, can BLOCK the call: exit code 2 (stderr =
  // reason) or stdout {"decision":"block","reason":"…"}.

  type HookEvent = "before_tool" | "after_tool" | "before_message" | "after_message";
  type HookEntry = string | { command: string; matcher?: string; timeout?: number };
  type HooksConfig = Partial<Record<HookEvent, HookEntry[]>>;

  function hookCommand(e: HookEntry): string { return typeof e === "string" ? e : e.command; }

  function loadHooks(): HooksConfig {
    const merged: HooksConfig = {};
    const paths = [
      join(homedir(), ".klaatai", "hooks.json"),
      join(projectRoot, ".klaatai", "hooks.json"),
    ];
    for (const p of paths) {
      if (!existsSync(p)) continue;
      try {
        const raw = JSON.parse(readFileSync(p, "utf-8")) as HooksConfig;
        for (const [evt, cmds] of Object.entries(raw) as [HookEvent, HookEntry[]][]) {
          merged[evt] = [...(merged[evt] ?? []), ...cmds];
        }
      } catch { /* ignore malformed */ }
    }
    return merged;
  }

  /**
   * Run hooks for an event. Returns a block reason when a before_tool hook
   * rejected the call, undefined otherwise.
   */
  function runHooks(event: HookEvent, extra: Record<string, string> = {}): string | undefined {
    const hooks = loadHooks();
    const entries = hooks[event] ?? [];
    if (entries.length === 0) return undefined;

    const env: Record<string, string> = {
      ...Object.fromEntries(Object.entries(process.env).filter(([, v]) => v !== undefined)) as Record<string, string>,
      KLAATAI_EVENT:        event,
      KLAATAI_PROJECT_ROOT: projectRoot,
      KLAATAI_SESSION_ID:   sessionId,
      ...extra,
    };

    // v2 JSON payload on stdin (v1 string hooks simply ignore stdin).
    const payload = JSON.stringify({
      event,
      session_id:   sessionId,
      project_root: projectRoot,
      tool_name:    extra["KLAATAI_TOOL_NAME"],
      tool_args:    extra["KLAATAI_TOOL_ARGS"],
      tool_result:  extra["KLAATAI_TOOL_RESULT"]?.slice(0, 8_000),
      user_message: extra["KLAATAI_USER_MESSAGE"],
      assistant_response: extra["KLAATAI_ASSISTANT_RESPONSE"],
    });

    for (const entry of entries) {
      const cmd = hookCommand(entry);
      // v2 matcher: regex against the tool name (tool events only).
      if (typeof entry !== "string" && entry.matcher) {
        const target = extra["KLAATAI_TOOL_NAME"] ?? "";
        try { if (!new RegExp(entry.matcher).test(target)) continue; }
        catch { /* invalid regex — run the hook anyway */ }
      }
      const timeout = (typeof entry !== "string" && entry.timeout ? entry.timeout : 5) * 1000;
      try {
        const res = spawnSync("sh", ["-c", cmd], {
          env, input: payload, timeout,
          stdio: ["pipe", "pipe", "pipe"], encoding: "utf-8",
        });
        if (event !== "before_tool") continue;
        // Blocking protocol (before_tool only)
        if (res.status === 2) {
          return (res.stderr || "").trim() || `blocked by hook: ${cmd.slice(0, 60)}`;
        }
        const out = (res.stdout || "").trim();
        if (out.startsWith("{")) {
          try {
            const j = JSON.parse(out) as { decision?: string; reason?: string };
            if (j.decision === "block") return j.reason || `blocked by hook: ${cmd.slice(0, 60)}`;
          } catch { /* not JSON — ignore */ }
        }
      } catch { /* ignore hook errors */ }
    }
    return undefined;
  }

  // GitHub-style diff row colors.
  const DIFF_ADD_BG = "#12261a", DIFF_DEL_BG = "#2d151a";
  const DIFF_ADD_FG = "#7ee787", DIFF_DEL_FG = "#ffa198";
  const DIFF_ADD_NUM = "#3fb950", DIFF_DEL_NUM = "#f85149";

  /** One diff line as a full-width styled row with gutter number + bg fill. */
  function diffRow(d: DiffLine, width: number): StyledLine {
    const bg =
      d.sign === "+" ? DIFF_ADD_BG :
      d.sign === "-" ? DIFF_DEL_BG : undefined;
    const numFg = d.sign === "+" ? DIFF_ADD_NUM : d.sign === "-" ? DIFF_DEL_NUM : palette.mutedFg;
    const txtFg = d.sign === "+" ? DIFF_ADD_FG : d.sign === "-" ? DIFF_DEL_FG : palette.mutedFg;
    const gutter = (d.ln !== undefined ? String(d.ln) : "").padStart(4);
    const sign = d.sign === "+" ? "+" : d.sign === "-" ? "-" : " ";
    const maxBody = Math.max(0, width - 8);
    const body = d.text.length > maxBody ? d.text.slice(0, maxBody - 1) + "…" : d.text;
    const used = 4 + 1 + 2 + stringWidth(body);
    const row: StyledLine = [
      span(gutter + " ", { fg: numFg, bg }),
      span(sign + " ", { fg: txtFg, bg, bold: true }),
      span(body, { fg: txtFg, bg }),
    ];
    if (used < width) row.push(span(" ".repeat(width - used), { bg }));
    return row;
  }

  /** Build a display diff for an edit/write tool call, or null. */
  function diffForTool(tc: ToolCall): { diff: DiffLine[]; path: string } | null {
    try {
      const args = JSON.parse(tc.function.arguments) as Record<string, unknown>;
      const path = String(args["path"] ?? args["file_path"] ?? "");
      // Read the current file to compute gutter line numbers (best-effort).
      let fileText = "";
      try {
        const abs = path.startsWith("/") ? path : join(projectRoot, path);
        if (existsSync(abs)) fileText = readFileSync(abs, "utf-8");
      } catch { /* no numbers */ }

      if (tc.function.name === "edit_file") {
        const newStr = String(args["new_string"] ?? "");
        const startLine = fileText ? lineOf(fileText, newStr) : undefined;
        return { path, diff: buildEditDiff(String(args["old_string"] ?? ""), newStr, startLine) };
      }
      if (tc.function.name === "multi_edit" && Array.isArray(args["edits"])) {
        return { path, diff: buildMultiEditDiff(args["edits"] as { old_string: string; new_string: string }[]) };
      }
      if (tc.function.name === "write_file") {
        return { path, diff: buildWriteDiff(String(args["content"] ?? "")) };
      }
      if (tc.function.name === "apply_patch") {
        const parsed = parsePatch(String(args["patch"] ?? ""));
        if (!parsed.ok || parsed.ops.length === 0) return null;
        const label = parsed.ops.length === 1
          ? parsed.ops[0]!.path
          : `${parsed.ops.length} files`;
        return { path: label, diff: buildPatchDiff(parsed.ops) };
      }
    } catch { /* ignore */ }
    return null;
  }

  async function executeWithPermission(tc: ToolCall): Promise<string> {
    const tool = tc.function.name;
    const blockReason = runHooks("before_tool", { KLAATAI_TOOL_NAME: tool, KLAATAI_TOOL_ARGS: tc.function.arguments });
    if (blockReason) return `Error: a project hook blocked this tool call: ${blockReason}`;

    // ── ask_user: blocking multiple-choice question ───────────────────
    if (tool === "ask_user") {
      let a: { question?: string; options?: string[]; allow_multiple?: boolean } = {};
      try { a = JSON.parse(tc.function.arguments); } catch { /* */ }
      const opts = (a.options ?? []).filter(o => typeof o === "string").slice(0, 4);
      if (!a.question || opts.length < 2) return "Error: ask_user needs a question and 2–4 options.";
      const answer = await requestUserAnswer(a.question, opts, !!a.allow_multiple);
      runHooks("after_tool", { KLAATAI_TOOL_NAME: tool, KLAATAI_TOOL_RESULT: answer });
      return `User selected: ${answer}`;
    }

    // ── Plan-mode exit: present plan, flag switch to Build ─────────────
    if (tool === "exit_plan_mode") {
      let plan = "";
      try { plan = String((JSON.parse(tc.function.arguments) as { plan?: string }).plan ?? ""); } catch { /* */ }
      pendingPlanExit = plan || "(no plan text provided)";
      runHooks("after_tool", { KLAATAI_TOOL_NAME: tool, KLAATAI_TOOL_RESULT: "plan presented" });
      return "Plan presented to the user and approved. You are now in Build mode — implement the plan.";
    }

    // ── MCP tool routing ──────────────────────────────────────────────
    if (mcpManager.isMCPTool(tool)) {
      let args: Record<string, unknown> = {};
      try { args = JSON.parse(tc.function.arguments); } catch { /* use empty args */ }
      const result = await mcpManager.callTool(tool, args);
      runHooks("after_tool", { KLAATAI_TOOL_NAME: tool, KLAATAI_TOOL_RESULT: result ?? "" });
      return result ?? "Error: MCP tool routing failed";
    }

    // delegate_task, plugin tools, and built-in tools share the same
    // permission flow; only the runner differs. Read-only delegations
    // (explore/review personas) count as safe; write-capable ones prompt
    // like any mutating tool. Plugin tools prompt unless the plugin
    // declares them in safeTools.
    const isDelegate = tool === "delegate_task";
    const isPlugin = pluginRegistry.has(tool);
    const runTool = () =>
      isDelegate ? executeDelegateTask(tc) :
      tool === "task_status" ? Promise.resolve(executeTaskStatus(tc)) :
      isPlugin ? pluginRegistry.call(tc, projectRoot) :
      executeTools(tc, projectRoot, client);
    const isSafe = isDelegate
      ? getPersona(parseDelegateArgs(tc).agent).readonly
      : isPlugin
        ? pluginRegistry.isSafe(tool)
        : SAFE_TOOLS.has(tool) || tool === "todo_write";

    // ── Silent path: read-only tools/delegations, session approvals ──
    if (isSafe || sessionApproved.has(tool)) {
      const result = await runTool();
      runHooks("after_tool", { KLAATAI_TOOL_NAME: tool, KLAATAI_TOOL_RESULT: result });
      return result;
    }

    const perms = loadPermissions();
    const check = checkPermission(tc, perms);
    if (check === "allow") {
      const result = await runTool();
      runHooks("after_tool", { KLAATAI_TOOL_NAME: tool, KLAATAI_TOOL_RESULT: result });
      return result;
    }
    if (check === "deny")   return "Error: Permission denied (matched deny rule).";

    const decision = await requestPermission(tc);
    switch (decision) {
      case "allow_once": {
        replState = "tool";
        const result = await runTool();
        runHooks("after_tool", { KLAATAI_TOOL_NAME: tool, KLAATAI_TOOL_RESULT: result });
        return result;
      }
      case "allow_session": {
        sessionApproved.add(tool);
        replState = "tool";
        const result = await runTool();
        runHooks("after_tool", { KLAATAI_TOOL_NAME: tool, KLAATAI_TOOL_RESULT: result });
        return result;
      }
      case "allow_always": {
        sessionApproved.add(tool);
        persistAlwaysAllow(tc);
        replState = "tool";
        const result = await runTool();
        runHooks("after_tool", { KLAATAI_TOOL_NAME: tool, KLAATAI_TOOL_RESULT: result });
        return result;
      }
      case "deny":
        replState = "tool";
        return "Error: User denied permission for this tool call.";
    }
  }

  // ─── Sub-agent delegation ─────────────────────────────────────────────────

  interface DelegateArgs { task?: string; context?: string; tier?: string; agent?: string; background?: boolean; }

  function parseDelegateArgs(tc: ToolCall): DelegateArgs {
    try { return JSON.parse(tc.function.arguments) as DelegateArgs; } catch { return {}; }
  }

  /** Live text of currently-running subagents, keyed by tool_call id (parallel-safe). */
  const subAgentLive = new Map<string, { persona: string; text: string }>();

  function renderSubAgentBuffer(): void {
    const entries = [...subAgentLive.values()];
    if (entries.length === 0) { streamBuffer = ""; return; }
    streamBuffer = entries
      .map(e => `[${e.persona}] ${e.text.length > 300 ? "…" + e.text.slice(-300) : e.text}`)
      .join("\n");
  }

  /**
   * Core sub-agent loop, UI-free: streams turns, executes the persona's tools,
   * reports live text through `onLive`. Throws on stream errors. Returns only
   * the agent's FINAL message — intermediate turns and tool noise stay in the
   * (discarded) subagent context.
   */
  async function runSubAgentLoop(args: DelegateArgs, onLive: (text: string) => void): Promise<string> {
    const persona = getPersona(args.agent);

    const subMessages: Message[] = [{ role: "system", content: persona.systemPrompt }];
    if (args.context) {
      subMessages.push({ role: "system", content: `Context from the caller:\n${args.context}` });
    }
    subMessages.push({ role: "user", content: args.task! });

    // Persona tool scoping. delegate_task is always excluded (no nested
    // delegation) and task_status too (the registry belongs to the parent);
    // MCP tools only for write-capable personas since their side effects are
    // unknown.
    // Dialect applies only when the persona has no explicit allowlist — a
    // curated list (e.g. explore's impact_check on the fast tier) wins.
    const subBase = persona.allowedTools === null
      ? toolsForDialect(activeDialect(args.tier ?? persona.tier), TOOL_DEFINITIONS)
      : TOOL_DEFINITIONS;
    const builtIn = subBase.filter(t =>
      t.function.name !== "delegate_task" &&
      t.function.name !== "task_status" &&
      (persona.allowedTools === null || persona.allowedTools.includes(t.function.name)));
    const subTools: ToolDefinition[] = persona.readonly
      ? builtIn
      : [...builtIn, ...mcpManager.toolDefinitions, ...pluginRegistry.toolDefinitions];

    let lastText   = "";
    let subApiMsgs = [...subMessages];

    let loopLimit = persona.loopLimit;
    while (loopLimit-- > 0) {
      let subPendingTools: ToolCall[] | null = null;
      let subText = "";

      const stream = client.chatStream(
        compactMessagesForApi(subApiMsgs, TIER_CONTEXT_WINDOW[args.tier ?? persona.tier], compactOpts()), {
        tools: subTools,
        tier:  args.tier ?? persona.tier,
      });

      for await (const chunk of stream) {
        if (chunk.type === "token") {
          subText += chunk.text ?? "";
          onLive(subText);
        } else if (chunk.type === "tool_call") {
          subPendingTools = chunk.tool_calls ?? null;
        } else if (chunk.type === "metadata" && chunk.usage) {
          // Count sub-agent tokens toward session totals
          totalTokens = {
            prompt:     totalTokens.prompt     + chunk.usage.prompt_tokens,
            completion: totalTokens.completion + chunk.usage.completion_tokens,
          };
          const tier = chunk.metadata?.tier ?? lastTier;
          const [inp, out] = TIER_COSTS[tier] ?? [0.5, 1.5];
          sessionCost += (chunk.usage.prompt_tokens * inp + chunk.usage.completion_tokens * out) / 1_000_000;
        }
      }

      if (subText.trim()) lastText = subText;

      if (subPendingTools && subPendingTools.length > 0) {
        subApiMsgs = [
          ...subApiMsgs,
          { role: "assistant", content: subText || "", tool_calls: subPendingTools },
        ];
        for (const stc of subPendingTools) {
          const stool = stc.function.name;
          let sresult: string;
          if (persona.allowedTools !== null && !persona.allowedTools.includes(stool)) {
            sresult = `Error: tool "${stool}" is not available to the ${persona.name} agent.`;
          } else if (mcpManager.isMCPTool(stool)) {
            let sargs: Record<string, unknown> = {};
            try { sargs = JSON.parse(stc.function.arguments); } catch { /* empty */ }
            sresult = await mcpManager.callTool(stool, sargs) ?? "(no result)";
          } else if (pluginRegistry.has(stool)) {
            sresult = await pluginRegistry.call(stc, projectRoot);
          } else {
            sresult = await executeTools(stc, projectRoot, client);
          }
          subApiMsgs = [
            ...subApiMsgs,
            { role: "tool", content: truncateToolResult(sresult), tool_call_id: stc.id },
          ];
        }
        continue;
      }
      break;
    }

    return lastText.trim() || "(sub-agent returned no output)";
  }

  // ─── Background agent tasks (delegate_task background:true) ───────────────

  interface BgAgentTask {
    id: string;
    persona: string;
    task: string;
    status: "running" | "done" | "error";
    result: string;    // final report (or error text)
    liveText: string;  // streaming tail while running
    startedAt: number;
    finishedAt?: number;
  }
  const bgTasks = new Map<string, BgAgentTask>();
  let bgTaskCounter = 0;
  /** Completion notes drained into the next user turn so the model learns without polling. */
  const bgTaskNotices: string[] = [];

  function startBackgroundDelegate(args: DelegateArgs): string {
    const persona = getPersona(args.agent);
    const id = `task-${++bgTaskCounter}`;
    const rec: BgAgentTask = {
      id, persona: persona.name, task: args.task!,
      status: "running", result: "", liveText: "", startedAt: Date.now(),
    };
    bgTasks.set(id, rec);
    ledger.note(`spawned background ${persona.name} agent ${id}: ${args.task!.slice(0, 120)}`);

    void runSubAgentLoop(args, (text) => { rec.liveText = text; })
      .then((result) => { rec.status = "done";  rec.result = result; })
      .catch((err)   => { rec.status = "error"; rec.result = `Sub-agent error: ${err instanceof Error ? err.message : String(err)}`; })
      .finally(() => {
        rec.finishedAt = Date.now();
        rec.liveText = "";
        const verb = rec.status === "done" ? "finished" : "FAILED";
        bgTaskNotices.push(`Background agent ${id} (${rec.persona}) ${verb} — call task_status("${id}") for the report.`);
        pushSystemMsg(`Background agent **${id}** (${rec.persona}) ${verb === "FAILED" ? "failed" : "finished"} — report via \`task_status("${id}")\`.`);
      });

    return `Started background agent ${id} (${persona.name}). It runs while you continue working; ` +
      `poll with task_status("${id}") — a note also appears in the conversation when it finishes. ` +
      `Do NOT sit idle waiting for it.`;
  }

  function executeTaskStatus(tc: ToolCall): string {
    let id: string | undefined;
    try { id = (JSON.parse(tc.function.arguments) as { id?: string }).id; } catch { /* list-all */ }

    if (!id) {
      if (bgTasks.size === 0) return "No background agent tasks this session.";
      return [...bgTasks.values()].map(t => {
        const dur = Math.round(((t.finishedAt ?? Date.now()) - t.startedAt) / 1000);
        return `${t.id} [${t.status}] (${t.persona}, ${dur}s) — ${t.task.slice(0, 100)}`;
      }).join("\n");
    }

    const t = bgTasks.get(id);
    if (!t) return `Error: no background task "${id}". Call task_status without an id to list tasks.`;
    if (t.status === "running") {
      const secs = Math.round((Date.now() - t.startedAt) / 1000);
      const tail = t.liveText.slice(-400);
      return `${t.id} [running] (${t.persona}, ${secs}s elapsed)\nLive output tail:\n${tail || "(no output yet)"}`;
    }
    return `${t.id} [${t.status}] (${t.persona})\nFinal report:\n${t.result}`;
  }

  async function executeDelegateTask(tc: ToolCall): Promise<string> {
    const args = parseDelegateArgs(tc);
    if (!args.task) return "Error: delegate_task requires a 'task' field.";
    if (args.background) return startBackgroundDelegate(args);

    const persona = getPersona(args.agent);
    replState    = "tool";
    subAgentLive.set(tc.id, { persona: persona.name, text: "" });
    ledger.note(`spawned ${persona.name} agent: ${args.task.slice(0, 120)}`);
    chatLinesDirty = true;
    app.requestRender();

    try {
      return await runSubAgentLoop(args, (text) => {
        subAgentLive.set(tc.id, { persona: persona.name, text });
        renderSubAgentBuffer();
        chatLinesDirty = true;
        app.requestRender();
      });
    } catch (err) {
      return `Sub-agent error: ${err instanceof Error ? err.message : String(err)}`;
    } finally {
      subAgentLive.delete(tc.id);
      renderSubAgentBuffer();
      chatLinesDirty = true;
    }
  }

  // ─── Slash commands ───────────────────────────────────────────────────────

  function pushSystemMsg(content: string, kind?: "error"): void {
    const msg: ChatMessage = { role: "assistant", content, kind };
    messages.push(msg);
    chatLinesDirty = true;
    chatAutoScroll = true;
    app.requestRender();
  }

  function handleSlashCommand(cmd: string): boolean {
    const parts = cmd.trim().split(/\s+/);
    const slash = parts[0]?.toLowerCase();

    switch (slash) {
      case "/exit":
      case "/quit":
        quit();
        return true;

      case "/agents": {
        const lines = ["**Agent personas** (for delegate_task):", ""];
        for (const p of Object.values(PERSONAS)) {
          lines.push(`- **${p.name}** — ${p.description} (tier ${p.tier}${p.readonly ? ", read-only, parallel" : ""})`);
        }
        const running = [...subAgentLive.values()];
        lines.push("", running.length
          ? `Running now: ${running.map(r => `[${r.persona}]`).join(" ")}`
          : "No agents running.");
        if (bgTasks.size > 0) {
          lines.push("", "**Background tasks:**");
          for (const t of bgTasks.values()) {
            const dur = Math.round(((t.finishedAt ?? Date.now()) - t.startedAt) / 1000);
            lines.push(`- ${t.id} [${t.status}] (${t.persona}, ${dur}s) — ${t.task.slice(0, 80)}`);
          }
        }
        pushSystemMsg(lines.join("\n"));
        return true;
      }

      case "/clear":
        messages.length = 0; // empty → welcome banner shows again
        apiMessages = seedSystemMessages(projectRoot, ledger.path);
        lastMeta = null;
        streamBuffer = "";
        modifiedFiles.length = 0;
        chatLinesDirty = true;
        chatAutoScroll = true;
        app.requestRender();
        return true;

      case "/cost": {
        let quotaBlock = "";
        if (lastQuota) {
          const q = lastQuota;
          const parts: string[] = [];
          if (q.unitsUsed !== undefined) {
            // Weighted request units (E1): heavy turns cost 5×, nano 0.25×.
            const limit = q.unitsLimit !== undefined ? ` / ${q.unitsLimit}` : "";
            parts.push(`  Units used: ${q.unitsUsed.toFixed(1)}${limit} (weighted)`);
          }
          if (q.requestsUsed !== undefined) {
            const limit = q.requestsLimit !== undefined ? ` / ${q.requestsLimit}` : "";
            parts.push(`  Requests:   ${q.requestsUsed}${limit}`);
          }
          if (q.plan) parts.push(`  Plan:       ${q.plan}`);
          if (parts.length) quotaBlock = `\n\n**Daily quota:**\n${parts.join("\n")}`;
        }
        // 9.4: burn rate + per-task attribution + budget cap status.
        const burn = burnRatePerMin();
        const avg  = sessionAvgPerMin();
        let burnBlock =
          `\n\n**Burn rate:**\n` +
          `  Last minute:  $${burn.toFixed(4)}/min\n` +
          `  Session avg:  $${avg.toFixed(4)}/min` +
          (avg > 0 && burn > 3 * avg ? `  ⚠ ${(burn / avg).toFixed(1)}× average` : "");
        if (config.maxSessionCost && config.maxSessionCost > 0) {
          const pct = Math.min(999, Math.round((sessionCost / config.maxSessionCost) * 100));
          burnBlock += `\n  Budget cap:   $${config.maxSessionCost.toFixed(2)} (${pct}% used)`;
        }
        const recentTasks = [
          ...taskCostLog.slice(-4),
          ...(currentTaskLabel !== null ? [{ label: `${currentTaskLabel} (current)`, cost: currentTaskCost }] : []),
        ];
        const taskBlock = recentTasks.length
          ? `\n\n**Per-task cost:**\n` +
            recentTasks.map(t => `  $${t.cost.toFixed(4)}  ${t.label}`).join("\n")
          : "";
        // 9.5: phase breakdown for the current task.
        const pt = phaseTracker.tokens;
        const phaseTotal = pt.explore + pt.implement + pt.verify;
        const phaseBlock = phaseTotal > 0
          ? `\n\n**Current task by phase:**\n` +
            (["explore", "implement", "verify"] as const)
              .filter(p => pt[p] > 0)
              .map(p => `  ${p.padEnd(9)} ${formatTok(pt[p])} / ${formatTok(phaseTracker.budgets[p])} toks${p === phaseTracker.phase ? "  ← now" : ""}`)
              .join("\n")
          : "";
        pushSystemMsg(
          `**Session:**\n` +
          `  Requests: ${totalRequests}\n` +
          `  Total input:  ${formatTok(totalTokens.prompt)} toks (cumulative)\n` +
          `  Total output: ${formatTok(totalTokens.completion)} toks (cumulative)\n` +
          `  Cost: $${sessionCost.toFixed(4)}\n\n` +
          `**Context (current):**\n` +
          `  Used: ${formatTok(lastContextSize)} / ${formatTok(getContextWindow())} toks` +
          burnBlock +
          phaseBlock +
          taskBlock +
          quotaBlock
        );
        return true;
      }

      case "/context": {
        // 9.6: visibility into what the model can still see vs what only
        // survives in the ledger.
        let sysN = 0, userN = 0, asstN = 0, toolN = 0, trimmedN = 0, chars = 0;
        for (const m of apiMessages) {
          if (m.role === "system") sysN++;
          else if (m.role === "user") userN++;
          else if (m.role === "assistant") asstN++;
          else if (m.role === "tool") toolN++;
          if (typeof m.content === "string") {
            chars += m.content.length;
            if (m.content.includes("chars trimmed")) trimmedN++;
          }
        }
        const window = getContextWindow();
        const pct = window > 0 ? Math.round((lastContextSize / window) * 100) : 0;
        const compactedStub = apiMessages.some(m =>
          typeof m.content === "string" && m.content.startsWith("[Context compacted"));
        pushSystemMsg(
          `**Context window:**\n` +
          `  Last request: ${formatTok(lastContextSize)} / ${formatTok(window)} toks (${pct}%)\n` +
          `  In memory: ${apiMessages.length} messages (${sysN} system, ${userN} user, ${asstN} assistant, ${toolN} tool) ≈ ${formatTok(Math.round(chars / 4))} toks\n` +
          `  Degraded in place: ${trimmedN} trimmed tool result${trimmedN === 1 ? "" : "s"}\n\n` +
          `**Compacted away:**\n` +
          `  Compactions this session: ${compactionCount}${compactedStub ? " (summary stub in context)" : ""}\n` +
          `  Recoverable details: ${ledger.path}\n` +
          `  (the model re-reads that file when it needs pre-compaction specifics)`
        );
        return true;
      }

      case "/why":
        if (lastMeta) {
          const rawModel = lastMeta.metadata.model ?? "";
          const shortModel = rawModel.includes("/") ? rawModel.split("/").pop()! : rawModel;
          const rawReason = lastMeta.metadata.reason ?? "";
          const friendlyReason = rawReason
            .replace(/_/g, " ")
            .replace(/\b\w/g, c => c.toUpperCase());
          pushSystemMsg([
            `Model:   ${shortModel}`,
            `Reason:  ${friendlyReason}`,
            `Tokens:  ${lastMeta.usage.prompt_tokens}↑ ${lastMeta.usage.completion_tokens}↓`,
            `Cost:    ${lastMeta.cost}`,
            `Tools:   ${activeDialect()} dialect (${toolsForDialect(activeDialect(), TOOL_DEFINITIONS).length} built-in)`,
          ].join("\n"));
        } else {
          pushSystemMsg("No request made yet.");
        }
        return true;

      case "/tier": {
        const tier = parts[1]?.toLowerCase();
        if (!tier) {
          openTierPicker();
        } else if (tier === "smart" || tier === "auto" || tier === "clear") {
          forceTier = null;
          pushSystemMsg("Routing tier cleared — smart routing restored.");
        } else if (VALID_TIERS.has(tier)) {
          forceTier = tier;
          pushSystemMsg(
            `Routing tier locked to **${tier}** for all subsequent messages.\n` +
            `Use \`/tier smart\` to restore smart routing.`
          );
        } else {
          pushSystemMsg(
            `Unknown tier "${tier}".\nValid tiers: nano · fast · code · reason · heavy\n\nExample: /tier fast`,
            "error"
          );
        }
        return true;
      }

      case "/model": {
        const sub = parts[1];
        if (!sub) { openModelPicker(); return true; }
        const subLower = sub.toLowerCase();

        // Courtesy migration: /model <tier> used to lock the routing tier.
        if (VALID_TIERS.has(subLower) || subLower === "smart") {
          pushSystemMsg(`Tier selection moved to \`/tier\` — applying \`/tier ${subLower}\` for you.`);
          return handleSlashCommand(`/tier ${subLower}`);
        }

        if (subLower === "add") {
          // /model add <name> <base_url> <model_id> [env:VAR | apiKey]
          const [, , name, baseUrl, modelId, keySpec] = parts;
          if (!name || !baseUrl || !modelId) {
            pushSystemMsg(
              "Usage: /model add <name> <base_url> <model_id> [env:API_KEY_VAR | api_key]\n" +
              "Example: /model add gpt4o https://api.openai.com gpt-4o env:OPENAI_API_KEY",
              "error",
            );
            return true;
          }
          if (!/^https?:\/\//.test(baseUrl)) {
            pushSystemMsg(`Base URL must start with http(s):// — got "${baseUrl}".`, "error");
            return true;
          }
          const cfg = loadConfig();
          const models = (cfg.customModels ?? []).filter(m => m.name.toLowerCase() !== name.toLowerCase());
          const entry: CustomModelConfig = { name, baseUrl, model: modelId };
          if (keySpec?.startsWith("env:")) entry.apiKeyEnv = keySpec.slice(4);
          else if (keySpec) entry.apiKey = keySpec;
          models.push(entry);
          saveConfig({ customModels: models });
          pushSystemMsg(
            `Custom model **${name}** saved (${modelId} @ ${baseUrl}).` +
            (entry.apiKey ? "\n⚠ API key stored in plaintext in ~/.klaatai/config.json — prefer env:VAR." : "") +
            `\nActivate: /model ${name}`,
          );
          return true;
        }

        if (subLower === "remove" || subLower === "rm") {
          const name = parts[2];
          if (!name) { pushSystemMsg("Usage: /model remove <name>", "error"); return true; }
          const cfg = loadConfig();
          const before = cfg.customModels ?? [];
          const after = before.filter(m => m.name.toLowerCase() !== name.toLowerCase());
          if (after.length === before.length) {
            pushSystemMsg(`No custom model named "${name}".`, "error");
            return true;
          }
          saveConfig({ customModels: after });
          if (activeCustomModel?.toLowerCase() === name.toLowerCase()) activateKlaatu();
          pushSystemMsg(`Custom model **${name}** removed.`);
          return true;
        }

        if (subLower === "list") { openModelPicker(); return true; }
        if (subLower === "klaatu") { activateKlaatu(); return true; }
        activateCustomModel(sub);
        return true;
      }

      case "/logout": {
        clearCredentials();
        client.updateToken("");
        pushSystemMsg(
          "Signed out — credentials cleared from ~/.klaatai/credentials.json.\n" +
          "The next request will open the browser to sign in again, or restart with `klaatai login`.",
        );
        return true;
      }

      case "/perms": {
        const perms = loadPermissions();
        pushSystemMsg([
          `Trusted tools:     ${perms.trusted_tools.join(", ") || "(none)"}`,
          `Allowed commands:  ${perms.allowed_commands.length} patterns`,
          `Denied commands:   ${perms.denied_commands.length} patterns`,
          `Session-approved:  ${[...sessionApproved].join(", ") || "(none)"}`,
          "",
          "Edit: ~/.klaatai/permissions.json",
        ].join("\n"));
        return true;
      }

      case "/help":
        pushSystemMsg([
          "Slash commands:",
          "  /clear            — clear conversation",
          "  /compact          — summarize context to free up token window",
          "  /cost             — show session cost",
          "  /diff [file]      — show git diff for a file (or all changes)",
          "  /init             — create .klaatai/rules.md from project analysis",
          "  /undo             — revert files written by the last AI response (via git)",
          "  /checkpoint [lbl] — snapshot modified files (max 10 kept)",
          "  /rollback [id]    — restore files from a checkpoint",
          "  /export [path]    — export current session to Markdown (default: ./klaatai-session-<id>.md)",
          "  /share [path]     — alias for /export",
          "  /plugin list      — list installed plugins in ~/.klaatai/plugins/",
          "  /doctor           — diagnostics: auth, API, MCP, tools, config",
          "  /theme [name]     — show or change the UI theme",
          "  /vimmode [on|off] — toggle vim key bindings (Esc=NORMAL, i/a/A/I=INSERT)",
          "  /test [args]      — run the project test suite (auto-detects Bun/Vitest/Jest/pytest/Go/Cargo)",
          "  /review [ref]     — AI code review of current diff (default: git diff HEAD)",
          "  /commit           — generate a git commit message with AI and confirm before committing",
          "  /skill [name]     — invoke a saved prompt skill; /skill list; /skill new <name>",
          "  /hooks            — list configured lifecycle hooks (before/after tool & message)",
          "  /why              — explain last routing decision",
          "  /tier [name]      — lock a Klaatu routing tier (nano/fast/code/reason/heavy); no arg = picker; /tier smart = auto",
          "  /model            — pick the model: Klaatu or a custom third-party API",
          "  /model add <name> <base_url> <model_id> [env:VAR|key] — save a custom OpenAI-compatible model",
          "  /model remove <name> — delete a custom model",
          "  /logout           — sign out and clear stored credentials",
          "  /perms            — show current permission rules",
          "  /mcp                        — list MCP servers and their status",
          "  /mcp enable <preset>        — connect a built-in MCP server (filesystem/github/git/…)",
          "  /mcp add <name> <cmd> [args] — add a custom stdio MCP server",
          "  /mcp disable <name>         — disconnect and remove a server",
          "  /sessions         — list saved sessions",
          "  /resume <id>      — resume a saved session",
          "  /help             — show this message",
          "  /exit             — quit",
          "",
          "Keyboard shortcuts:",
          "  ctrl+p            — command palette",
          "  ctrl+x ctrl+e     — open $EDITOR to compose message",
          "  @                 — insert file reference (fuzzy file picker)",
          "  !<cmd>            — run shell command and inject output as context",
          "  Tab / Shift+Tab   — switch Build/Plan agent mode",
          "  Esc               — interrupt streaming (or NORMAL mode if vim on)",
          "  ↑ / ↓             — history navigation",
          "  Paste image path  — attach image to next message (vision)",
          "  ctrl+v            — attach image from clipboard (screenshots)",
          "",
          "Vim NORMAL mode bindings (when /vimmode on):",
          "  h/l           — move cursor left/right",
          "  j/k           — scroll chat down/up",
          "  w/e/b         — word forward/forward/back",
          "  0/$           — start/end of line",
          "  x             — delete char under cursor",
          "  p/P           — paste last delete after/before cursor",
          "  i/a/A/I       — enter INSERT mode (cursor/after/end-of-line/start-of-line)",
          "  d then d/w/$  — delete line/word/to-end",
          "  D             — delete to end of line",
          "  gg/G          — scroll chat to top/bottom",
          "  ctrl+u/ctrl+d — scroll chat up/down half-page",
        ].join("\n"));
        return true;

      default: {
        if (slash === "/checkpoint") {
          const label = parts.slice(1).join(" ").trim() || "manual";
          const id    = `cp-${Date.now()}`;
          const files: Record<string, string> = {};
          for (const f of modifiedFiles) {
            try {
              const absPath = resolve(projectRoot, f.path);
              files[f.path] = readFileSync(absPath, "utf-8");
            } catch { /* skip unreadable */ }
          }
          checkpoints.push({ id, label, timestamp: Date.now(), files });
          if (checkpoints.length > 10) checkpoints.splice(0, checkpoints.length - 10);
          const count = Object.keys(files).length;
          pushSystemMsg(
            `Checkpoint **${id}** saved — ${count} file(s) snapshotted.\n` +
            `Label: ${label}\n\n` +
            `Use \`/rollback ${id}\` to restore.`
          );
          return true;
        }

        if (slash === "/rollback") {
          if (checkpoints.length === 0) {
            pushSystemMsg("No checkpoints saved yet. Use `/checkpoint [label]` first.", "error");
            return true;
          }
          const idOrLabel = parts[1];
          if (!idOrLabel) {
            const list = checkpoints.slice().reverse()
              .map(c => {
                const d = new Date(c.timestamp).toISOString().slice(0, 19).replace("T", " ");
                return `  **${c.id}** — ${c.label} (${d}) — ${Object.keys(c.files).length} files`;
              }).join("\n");
            pushSystemMsg(`Checkpoints (${checkpoints.length}):\n\n${list}\n\nUsage: /rollback <id>`);
            return true;
          }
          const cp = checkpoints.find(c => c.id === idOrLabel || c.label === idOrLabel)
            ?? (idOrLabel === "last" ? checkpoints[checkpoints.length - 1] : undefined);
          if (!cp) {
            pushSystemMsg(`No checkpoint matching "${idOrLabel}". Use /rollback to list.`, "error");
            return true;
          }
          let restored = 0;
          const errors: string[] = [];
          for (const [relPath, content] of Object.entries(cp.files)) {
            try {
              const absPath = resolve(projectRoot, relPath);
              writeFileSync(absPath, content, "utf-8");
              restored++;
            } catch (e) {
              errors.push(relPath + ": " + (e instanceof Error ? e.message : String(e)));
            }
          }
          const errNote = errors.length > 0 ? `\n\nErrors:\n${errors.join("\n")}` : "";
          pushSystemMsg(`Rolled back to checkpoint **${cp.id}** (${cp.label}) — ${restored} file(s) restored.${errNote}`);
          return true;
        }

        if (slash === "/export" || slash === "/share") {
          const pathArg = parts.slice(1).join(" ").trim() || undefined;
          const outPath = resolveExportPath(sessionId, pathArg);
          const md = renderSessionMarkdown({
            sessionId,
            messages,
            sessionCost,
            totalRequests,
          });
          try {
            writeFileSync(outPath, md, "utf-8");
            pushSystemMsg(`Session exported to **${outPath}**`);
          } catch (e) {
            pushSystemMsg(`Export failed: ${e instanceof Error ? e.message : String(e)}`, "error");
          }
          return true;
        }

        if (slash === "/plugin" || slash === "/plugins") {
          const sub = parts[1]?.toLowerCase();
          if (!sub || sub === "list") {
            if (pluginRegistry.plugins.length === 0 && pluginRegistry.errors.length === 0) {
              pushSystemMsg(
                "No plugins loaded.\n\n" +
                "Locations: `~/.klaatai/plugins/*.js` (global) or `.klaatai/tools/*.js` (project).\n\n" +
                "Plugin module format:\n" +
                "```js\n" +
                "export default {\n" +
                "  name: \"my-plugin\",\n" +
                "  tools: [{ type: \"function\", function: { name: \"my_tool\",\n" +
                "    description: \"…\", parameters: { type: \"object\", properties: {} } } }],\n" +
                "  safeTools: [\"my_tool\"],  // optional: no permission prompt\n" +
                "  async execute(toolCall, projectRoot) { return \"result\"; },\n" +
                "}\n" +
                "```\n" +
                "Use `/plugin reload` after adding files."
              );
            } else {
              const lines = ["**Loaded plugins:**\n"];
              for (const p of pluginRegistry.plugins) {
                const toolNames = p.tools.map(t => `\`${t.function.name}\``).join(", ");
                lines.push(`  **${p.name}** *(${p.scope})* — ${toolNames}`);
              }
              if (pluginRegistry.errors.length > 0) {
                lines.push("", "**Load errors:**");
                for (const e of pluginRegistry.errors) lines.push(`  ✖ \`${e.file}\` — ${e.error}`);
              }
              lines.push("", "`/plugin reload` re-scans plugin directories.");
              pushSystemMsg(lines.join("\n"));
            }
            return true;
          }
          if (sub === "reload") {
            void pluginRegistry.load(projectRoot).then(() => {
              pushSystemMsg(`Plugins reloaded: ${pluginRegistry.plugins.length} plugin(s), ${pluginRegistry.toolDefinitions.length} tool(s)` +
                (pluginRegistry.errors.length ? `, ${pluginRegistry.errors.length} error(s) — see /plugin list` : "") + ".");
            });
            return true;
          }
          pushSystemMsg(`Unknown /plugin subcommand: "${sub}"\n\nUsage: /plugin list · /plugin reload`, "error");
          return true;
        }

        if (slash === "/vimmode") {
          const arg = parts[1]?.toLowerCase();
          if (arg === "on")       vimMode = true;
          else if (arg === "off") vimMode = false;
          else                    vimMode = !vimMode;
          vimInsert = true; // always start in INSERT when toggling
          saveConfig({ vimMode });
          chatLinesDirty = true;
          pushSystemMsg(
            vimMode
              ? "Vim mode **enabled**.\n\n`Esc` → NORMAL · `i/a/A/I` → INSERT · `h/j/k/l` move · `w/b/e` word · `0/$` line · `x` delete · `p`/`P` paste · `dd` clear · `D` kill-to-end · `gg`/`G` scroll chat · `ctrl+d`/`ctrl+u` half-page\n\n`/vimmode off` to disable."
              : "Vim mode **disabled**.",
          );
          app.requestRender();
          return true;
        }

        if (slash === "/sessions") {
          const sessions = getSessionList();
          if (sessions.length === 0) {
            pushSystemMsg("No saved sessions found.\n\nSessions are saved automatically in `~/.klaatai/sessions/`.");
          } else {
            const lines = [
              `${sessions.length} saved session(s) — use /resume <id> to load:\n`,
              ...sessions.slice(0, 10).map(s => `  **${s.id}**\n  ${s.date}  —  ${s.preview}…`),
            ];
            pushSystemMsg(lines.join("\n"));
          }
          return true;
        }

        if (slash === "/resume") {
          const id = parts[1];
          const sessions = getSessionList();
          if (!id) {
            if (sessions.length === 0) {
              pushSystemMsg("No saved sessions to resume.", "error");
            } else {
              const preview = sessions.slice(0, 5).map(s => `  ${s.id}  —  ${s.preview}…`).join("\n");
              pushSystemMsg(`Usage: /resume <id>\n\nRecent sessions:\n${preview}`);
            }
            return true;
          }
          const session = sessions.find(s => s.id.includes(id));
          if (!session) {
            pushSystemMsg(`No session matching "${id}". Use /sessions to list saved sessions.`, "error");
            return true;
          }
          const { msgs, apiMsgs } = loadSessionFromFile(session.file);
          messages.splice(0, messages.length, ...msgs);
          apiMessages = [...seedSystemMessages(projectRoot, ledger.path), ...apiMsgs];
          chatLinesDirty = true;
          chatAutoScroll = true;
          pushSystemMsg(`Resumed session **${session.id}** — ${msgs.length} messages loaded.`);
          return true;
        }

        if (slash === "/compact") {
          if (apiMessages.length < 6) {
            pushSystemMsg("Context is short — no compact needed.");
            return true;
          }
          pushSystemMsg("Compacting context…");
          consecutiveCompactFailures = 0; // manual retry always allowed
          void compactContext();
          return true;
        }

        if (slash === "/diff") {
          const diffFile = parts[1];
          const gitArgs  = diffFile ? ["diff", "HEAD", "--", diffFile] : ["diff", "HEAD"];
          try {
            const result = spawnSync("git", gitArgs, {
              cwd: projectRoot,
              encoding: "utf-8",
              timeout: 10_000,
            });
            const diffOutput = (result.stdout ?? "").trim() || (result.stderr ?? "").trim();
            if (!diffOutput) {
              pushSystemMsg(diffFile
                ? `No git diff for \`${diffFile}\` (nothing staged/modified or not a git repo).`
                : "No git diff (nothing staged/modified or not a git repo)."
              );
            } else {
              const header = diffFile ? `git diff HEAD -- ${diffFile}` : "git diff HEAD";
              pushSystemMsg(`**${header}**\n\n\`\`\`diff\n${diffOutput}\n\`\`\``);
            }
          } catch (err) {
            pushSystemMsg(`Error running git diff: ${err instanceof Error ? err.message : String(err)}`, "error");
          }
          return true;
        }

        if (slash === "/theme" || slash === "/themes") {
          const name = parts[1]?.toLowerCase() as Theme | undefined;
          if (!name) {
            // Open interactive theme picker
            const currentIdx = THEME_NAMES.indexOf(activeTheme);
            themePicker = { cursor: currentIdx >= 0 ? currentIdx : 0 };
            chatLinesDirty = true;
            app.requestRender();
          } else if (THEME_NAMES.includes(name)) {
            activeTheme    = name;
            palette        = getPalette(name);
            chatLinesDirty = true;
            saveConfig({ theme: name });
            pushSystemMsg(`Theme switched to **${name}**. ${THEME_DESCRIPTIONS[name]}`);
          } else {
            pushSystemMsg(
              `Unknown theme "${name}".\nAvailable: ${THEME_NAMES.join(", ")}\n\nTip: /themes to see descriptions.`,
              "error"
            );
          }
          return true;
        }

        if (slash === "/init") {
          // Analyse the project and write .klaatai/rules.md
          const rulesDir  = join(projectRoot, ".klaatai");
          const rulesFile = join(rulesDir, "rules.md");
          if (existsSync(rulesFile)) {
            pushSystemMsg(`\`.klaatai/rules.md\` already exists.\n\nEdit it directly, or delete it and run \`/init\` again to regenerate.`);
            return true;
          }

          // Detect tech stack from well-known marker files
          type StackEntry = { lang: string; file: string; extra?: string };
          const STACK_MARKERS: StackEntry[] = [
            { lang: "TypeScript / Node.js", file: "tsconfig.json" },
            { lang: "JavaScript / Node.js", file: "package.json" },
            { lang: "Go",                   file: "go.mod" },
            { lang: "Python",               file: "pyproject.toml" },
            { lang: "Python",               file: "requirements.txt" },
            { lang: "Rust",                 file: "Cargo.toml" },
            { lang: "Java / Kotlin",        file: "pom.xml" },
            { lang: "Java / Kotlin",        file: "build.gradle" },
            { lang: "C# / .NET",            file: "*.csproj", extra: "dotnet" },
            { lang: "Ruby",                 file: "Gemfile" },
            { lang: "PHP",                  file: "composer.json" },
            { lang: "Swift",                file: "Package.swift" },
          ];
          const detectedStacks = STACK_MARKERS
            .filter(m => {
              if (m.file.includes("*")) {
                try {
                  const result = spawnSync("sh", ["-c", `ls ${projectRoot}/${m.file} 2>/dev/null | head -1`], { encoding: "utf-8" });
                  return (result.stdout ?? "").trim().length > 0;
                } catch { return false; }
              }
              return existsSync(join(projectRoot, m.file));
            })
            .map(m => m.lang);
          const uniqueStacks = [...new Set(detectedStacks)];

          // Check for git, test frameworks, etc.
          const hasGit        = existsSync(join(projectRoot, ".git"));
          const hasBun        = existsSync(join(projectRoot, "bun.lockb")) || existsSync(join(projectRoot, "bun.lock"));
          const hasDocker     = existsSync(join(projectRoot, "Dockerfile")) || existsSync(join(projectRoot, "docker-compose.yml"));
          const hasESLint     = existsSync(join(projectRoot, ".eslintrc.js")) || existsSync(join(projectRoot, "eslint.config.js"));
          const hasPrettier   = existsSync(join(projectRoot, ".prettierrc")) || existsSync(join(projectRoot, "prettier.config.js"));
          const hasVitest     = existsSync(join(projectRoot, "vitest.config.ts")) || existsSync(join(projectRoot, "vitest.config.js"));
          const hasJest       = existsSync(join(projectRoot, "jest.config.js")) || existsSync(join(projectRoot, "jest.config.ts"));

          const tooling: string[] = [];
          if (hasBun)     tooling.push("Bun runtime");
          if (hasDocker)  tooling.push("Docker");
          if (hasESLint)  tooling.push("ESLint");
          if (hasPrettier) tooling.push("Prettier");
          if (hasVitest)  tooling.push("Vitest");
          if (hasJest)    tooling.push("Jest");

          // Read package.json name/description if present
          let projectName = projectRoot.split("/").pop() ?? "this project";
          let projectDesc = "";
          try {
            const pkg = JSON.parse(readFileSync(join(projectRoot, "package.json"), "utf-8"));
            if (pkg.name)        projectName = pkg.name;
            if (pkg.description) projectDesc = pkg.description;
          } catch { /* ignore */ }

          const rulesContent = [
            `# ${projectName} — KlaatAI Project Rules`,
            "",
            projectDesc ? `> ${projectDesc}` : "",
            "",
            "## Tech Stack",
            uniqueStacks.length > 0
              ? uniqueStacks.map(s => `- ${s}`).join("\n")
              : "- (auto-detection found nothing — please fill this in)",
            tooling.length > 0 ? "\n## Tooling\n" + tooling.map(t => `- ${t}`).join("\n") : "",
            "",
            "## Repository",
            `- Root: \`${projectRoot}\``,
            hasGit ? "- Version control: Git" : "",
            "",
            "## Coding Guidelines",
            "- Read files before editing them.",
            "- Prefer small, targeted changes over large rewrites.",
            "- Run the test suite after making changes.",
            "- Keep functions short and focused.",
            "- Add comments for non-obvious logic.",
            "",
            "## AI Agent Instructions",
            "- Always confirm what files you changed and why.",
            "- If unsure about intent, ask before making changes.",
            "- Prefer editing existing patterns over introducing new ones.",
          ].filter(l => l !== undefined).join("\n");

          try {
            mkdirSync(rulesDir, { recursive: true });
            writeFileSync(rulesFile, rulesContent.trim() + "\n", "utf-8");
            // Inject the rules into the current session
            apiMessages.push({ role: "system", content: `Project rules (from .klaatai/rules.md):\n\n${rulesContent}` });
            pushSystemMsg(
              `Created \`.klaatai/rules.md\`\n\n` +
              (uniqueStacks.length > 0 ? `Detected: ${uniqueStacks.join(", ")}\n\n` : "") +
              `Edit \`.klaatai/rules.md\` to customise AI behaviour for this project.`
            );
          } catch (err) {
            pushSystemMsg(`Failed to write .klaatai/rules.md: ${err instanceof Error ? err.message : String(err)}`, "error");
          }
          return true;
        }

        if (slash === "/undo") {
          if (undoStack.length === 0) {
            pushSystemMsg("Nothing to undo — no files have been written this session.");
            return true;
          }
          const lastWrites = undoStack[undoStack.length - 1]!;
          // Use git checkout to revert to HEAD
          const gitResult = spawnSync("git", ["checkout", "HEAD", "--", ...lastWrites], {
            cwd:      projectRoot,
            encoding: "utf-8",
            timeout:  10_000,
          });
          if (gitResult.status === 0) {
            undoStack.pop();
            // Remove from modifiedFiles
            for (const f of lastWrites) {
              const idx = modifiedFiles.findIndex(m => m.path === f || resolve(projectRoot, m.path) === f);
              if (idx !== -1) modifiedFiles.splice(idx, 1);
            }
            chatLinesDirty = true;
            pushSystemMsg(
              `Reverted ${lastWrites.length} file(s) to HEAD:\n` +
              lastWrites.map(f => `  - \`${relative(projectRoot, f)}\``).join("\n") +
              `\n\nRun \`/undo\` again to revert the previous batch (${undoStack.length} more available).`
            );
          } else {
            // Fallback: not a git repo — just warn
            pushSystemMsg(
              `Could not revert via git (exit ${gitResult.status}): ${gitResult.stderr?.trim() || "not a git repo?"}\n\n` +
              `Files that were written:\n` +
              lastWrites.map(f => `  - \`${f}\``).join("\n"),
              "error"
            );
          }
          return true;
        }

        if (slash === "/doctor") {
          const lines: string[] = ["**KlaatAI Diagnostics**\n"];

          // Auth
          const authToken = config.baseUrl ? "configured" : null;
          const hasToken = !!(process.env["KLAATAI_API_KEY"] ?? getAuthToken());
          lines.push(hasToken ? "● Auth           — API key found" : "✗ Auth           — No API key (run: klaatai login)");

          // API reachability — use lifetimeStats we already fetched
          if (lifetimeStats) {
            lines.push(`● API            — Reachable (${lifetimeStats.total_requests} lifetime requests)`);
          } else {
            lines.push("○ API            — Not yet verified (stats not loaded)");
          }

          // MCP servers
          const mcpServers = mcpManager.servers;
          if (mcpServers.length === 0) {
            lines.push("○ MCP Servers    — None configured (/mcp enable <preset>)");
          } else {
            for (const s of mcpServers) {
              const icon = s.status === "connected" ? "●" : s.status === "error" ? "✗" : "○";
              lines.push(`${icon} MCP ${s.name.padEnd(10)} — ${s.status}${s.status === "error" ? ": " + s.statusMessage : ""}`);
            }
          }

          // Tools
          lines.push(`● Tools          — ${TOOL_DEFINITIONS.length} built-in + ${mcpManager.toolDefinitions.length} MCP (active dialect: ${activeDialect()}, ${toolsForDialect(activeDialect(), TOOL_DEFINITIONS).length} sent)`);

          // Project rules
          const rulesExist = existsSync(join(projectRoot, ".klaatai", "rules.md"));
          lines.push(rulesExist ? "● Project rules  — .klaatai/rules.md found" : "○ Project rules  — Not set (/init to create)");

          // Session
          lines.push(`● Session        — ${messages.filter(m => m.role === "user").length} messages, $${sessionCost.toFixed(4)} cost`);

          // Config
          lines.push(`● Config         — theme: ${activeTheme}, routing: ${config.routingDisplay ?? "minimal"}`);
          lines.push(`● Base URL       — ${config.baseUrl}`);
          void authToken;

          pushSystemMsg(lines.join("\n"));
          return true;
        }

        if (slash === "/mcp") {
          const sub = parts[1]?.toLowerCase();

          // /mcp enable <preset>
          if (sub === "enable") {
            const presetId = parts[2];
            if (!presetId) {
              const presetList = MCP_PRESETS.map(p =>
                `  **${p.id}** — ${p.description}` +
                (p.envVars ? `\n    Needs: ${p.envVars.map(e => `\`${e}\``).join(", ")}` : "")
              ).join("\n");
              pushSystemMsg(`Usage: \`/mcp enable <preset>\`\n\nAvailable presets:\n\n${presetList}`);
              return true;
            }
            const preset = getMCPPreset(presetId);
            if (!preset) {
              const ids = MCP_PRESETS.map(p => p.id).join(", ");
              pushSystemMsg(`Unknown preset "${presetId}".\n\nAvailable: ${ids}`, "error");
              return true;
            }
            // Warn on missing required env vars
            const missingEnv = (preset.envVars ?? []).filter(v => !process.env[v]);
            if (missingEnv.length > 0) {
              pushSystemMsg(
                `Warning: **${preset.name}** requires env var(s): ${missingEnv.map(v => `\`${v}\``).join(", ")}.\n` +
                `Set them in your shell before starting KlaatCode, or the server may fail to connect.\n\nEnabling anyway…`
              );
            }
            // Write to ~/.klaatai/mcp.json using already-imported fs/path/os
            const mcpConfigPath = join(homedir(), ".klaatai", "mcp.json");
            mkdirSync(join(homedir(), ".klaatai"), { recursive: true });
            let existing: { servers?: Record<string, unknown> } = { servers: {} };
            if (existsSync(mcpConfigPath)) {
              try { existing = JSON.parse(readFileSync(mcpConfigPath, "utf-8")); } catch { /* ignore */ }
            }
            const servers2 = { ...(existing.servers ?? {}), [preset.id]: preset.config };
            writeFileSync(mcpConfigPath, JSON.stringify({ servers: servers2 }, null, 2), "utf-8");
            // Connect immediately (fire-and-forget)
            mcpManager.connectOne(preset.id, preset.config);
            pushSystemMsg(
              `**${preset.name}** MCP server enabled and connecting…\n\n` +
              `Config saved to \`~/.klaatai/mcp.json\`.\n` +
              `Check status with \`/mcp\` or see the sidebar.`
            );
            return true;
          }

          // /mcp add <name> <command> [args...]
          if (sub === "add") {
            const serverName = parts[2];
            const command = parts[3];
            if (!serverName || !command) {
              pushSystemMsg(
                "Usage: `/mcp add <name> <command> [args...]`\n" +
                "       `/mcp add <name> <https://url> [Header: value]`\n\n" +
                "Examples:\n" +
                "  `/mcp add filesystem npx -y @modelcontextprotocol/server-filesystem /path`\n" +
                "  `/mcp add github npx -y @modelcontextprotocol/server-github`\n" +
                "  `/mcp add linear https://mcp.linear.app/mcp Authorization: Bearer lin_…`",
                "error"
              );
              return true;
            }
            const serverArgs = parts.slice(4);
            // URL → remote Streamable HTTP server; trailing "Header: value" pairs become headers.
            const isUrl = /^https?:\/\//.test(command);
            let serverConfig: MCPServerConfig;
            if (isUrl) {
              const headers: Record<string, string> = {};
              const headerText = serverArgs.join(" ");
              for (const m of headerText.matchAll(/([\w-]+):\s*([^,]+?)(?=\s+[\w-]+:|$)/g)) {
                headers[m[1]!] = m[2]!.trim();
              }
              serverConfig = { url: command, ...(Object.keys(headers).length ? { headers } : {}) };
            } else {
              serverConfig = { command, args: serverArgs.length > 0 ? serverArgs : undefined };
            }
            const mcpAddPath = join(homedir(), ".klaatai", "mcp.json");
            mkdirSync(join(homedir(), ".klaatai"), { recursive: true });
            let existingAdd: { servers?: Record<string, unknown> } = { servers: {} };
            if (existsSync(mcpAddPath)) {
              try { existingAdd = JSON.parse(readFileSync(mcpAddPath, "utf-8")); } catch { /* ignore */ }
            }
            const updatedServers = { ...(existingAdd.servers ?? {}), [serverName]: serverConfig };
            writeFileSync(mcpAddPath, JSON.stringify({ servers: updatedServers }, null, 2), "utf-8");
            mcpManager.connectOne(serverName, serverConfig);
            pushSystemMsg(
              `**${serverName}** added and connecting…\n\n` +
              (isUrl
                ? `URL: \`${command}\` (Streamable HTTP)\n`
                : `Command: \`${command}${serverArgs.length > 0 ? " " + serverArgs.join(" ") : ""}\`\n`) +
              `Config saved to \`~/.klaatai/mcp.json\`.\n` +
              `Check status with \`/mcp\`.`
            );
            return true;
          }

          // /mcp disable <name>
          if (sub === "disable") {
            const serverName = parts[2];
            if (!serverName) {
              pushSystemMsg("Usage: `/mcp disable <server-name>`", "error");
              return true;
            }
            const runtime = mcpManager.servers.find(s => s.name === serverName);
            const fromHome = !runtime?.source || runtime.source === "~/.klaatai/mcp.json";
            const mcpConfigPath2 = join(homedir(), ".klaatai", "mcp.json");
            if (fromHome && existsSync(mcpConfigPath2)) {
              try {
                const cfg = JSON.parse(readFileSync(mcpConfigPath2, "utf-8")) as { servers?: Record<string, unknown> };
                if (cfg.servers && serverName in cfg.servers) {
                  delete cfg.servers[serverName];
                  writeFileSync(mcpConfigPath2, JSON.stringify(cfg, null, 2), "utf-8");
                  mcpManager.disconnectOne(serverName);
                  pushSystemMsg(`Server **${serverName}** disabled and removed from \`~/.klaatai/mcp.json\`.`);
                } else if (runtime?.source) {
                  mcpManager.disconnectOne(serverName);
                  pushSystemMsg(
                    `Server **${serverName}** disconnected for this session.\n\n` +
                    `It is loaded from \`${runtime.source}\` — edit that file to remove it permanently.`,
                  );
                } else {
                  pushSystemMsg(`No server named "${serverName}" found in config.`, "error");
                }
              } catch { pushSystemMsg("Failed to update mcp.json.", "error"); }
            } else if (runtime?.source) {
              mcpManager.disconnectOne(serverName);
              pushSystemMsg(
                `Server **${serverName}** disconnected for this session.\n\n` +
                `It is loaded from \`${runtime.source}\` — edit that file to remove it permanently.`,
              );
            } else {
              pushSystemMsg("No mcp.json config found.", "error");
            }
            return true;
          }

          // /mcp (status list — default)
          const servers = mcpManager.servers;
          if (servers.length === 0) {
            const previewList = MCP_PRESETS.slice(0, 4).map(p => `  \`/mcp enable ${p.id}\` — ${p.name}: ${p.description}`).join("\n");
            pushSystemMsg(
              "No MCP servers configured.\n\n" +
              "Enable a preset server:\n" + previewList + "\n" +
              `\n\`/mcp enable\` — see all available presets\n\n` +
              "Or create `~/.klaatai/mcp.json` manually with your own servers."
            );
          } else {
            const lines = servers.map(s => {
              const icon = s.status === "connected" ? "●" : s.status === "error" ? "✗" : "○";
              const toolList = s.tools.slice(0, 5).map(t => `\`${t.name}\``).join(", ");
              const more = s.tools.length > 5 ? ` + ${s.tools.length - 5} more` : "";
              const sourceHint = s.source ? ` *(from ${s.source})*` : "";
              return `${icon} **${s.name}**${sourceHint} — ${s.status}: ${s.statusMessage}${s.status === "connected" ? `\n  Tools: ${toolList}${more}` : ""}`;
            });
            pushSystemMsg(`**MCP Servers** (${servers.length}):\n\n${lines.join("\n\n")}\n\n\`/mcp enable <preset>\` to add more`);
          }
          return true;
        }

        // ── /test — project-aware test runner ─────────────────────────────
        if (slash === "/test") {
          const hasBunLock = existsSync(join(projectRoot, "bun.lockb")) || existsSync(join(projectRoot, "bun.lock"));
          const hasVitest  = existsSync(join(projectRoot, "vitest.config.ts")) || existsSync(join(projectRoot, "vitest.config.js"));
          const hasJest    = existsSync(join(projectRoot, "jest.config.js")) || existsSync(join(projectRoot, "jest.config.ts"));
          const hasPytest  = existsSync(join(projectRoot, "pytest.ini")) || existsSync(join(projectRoot, "pyproject.toml"));
          const hasGo      = existsSync(join(projectRoot, "go.mod"));
          const hasCargo   = existsSync(join(projectRoot, "Cargo.toml"));
          const hasPkg     = existsSync(join(projectRoot, "package.json"));

          let testCmd: string | null = null;
          let testRunner = "";

          if (hasBunLock) {
            testCmd = "bun test"; testRunner = "Bun";
          } else if (hasVitest) {
            testCmd = "npx vitest run"; testRunner = "Vitest";
          } else if (hasJest) {
            testCmd = "npx jest --no-coverage"; testRunner = "Jest";
          } else if (hasPytest) {
            testCmd = "python -m pytest -v"; testRunner = "pytest";
          } else if (hasGo) {
            testCmd = "go test ./..."; testRunner = "Go";
          } else if (hasCargo) {
            testCmd = "cargo test"; testRunner = "Cargo";
          } else if (hasPkg) {
            try {
              const pkg = JSON.parse(readFileSync(join(projectRoot, "package.json"), "utf-8")) as { scripts?: Record<string, string> };
              const testScript = pkg.scripts?.["test"] ?? "";
              if (testScript && !testScript.startsWith("echo")) {
                testCmd = "npm test"; testRunner = "npm";
              }
            } catch { /* ignore */ }
          }

          if (!testCmd) {
            pushSystemMsg("No test framework detected.\n\nSupported: Bun, Vitest, Jest, pytest, Go (`go.mod`), Cargo (`Cargo.toml`), npm (package.json `test` script).", "error");
            return true;
          }

          const extraArgs = parts.slice(1).join(" ").trim();
          const fullCmd   = extraArgs ? `${testCmd} ${extraArgs}` : testCmd;
          pushSystemMsg(`Running **${testRunner}** tests…\n\`${fullCmd}\``);
          chatLinesDirty = true;
          app.requestRender();

          void new Promise<void>((res) => {
            exec(fullCmd, { cwd: projectRoot, env: process.env, timeout: 120_000 }, (err, stdout, stderr) => {
              const out     = [stdout, stderr].filter(Boolean).join("\n").trim();
              const code    = (err as NodeJS.ErrnoException & { code?: number })?.code ?? (err ? 1 : 0);
              const icon    = code === 0 ? "✓" : "✗";
              const status  = code === 0 ? "passed" : "failed";
              const snippet = out.length > 4000
                ? out.slice(0, 4000) + "\n[truncated — " + (out.length - 4000) + " chars omitted]"
                : out;
              pushSystemMsg(
                `${icon} **${testRunner} tests ${status}** (exit ${code})\n\n` +
                (snippet ? "```\n" + snippet + "\n```" : "(no output)"),
              );
              chatLinesDirty = true;
              app.requestRender();
              res();
            });
          });
          return true;
        }

        // ── /review — AI-powered code review of current git diff ───────────
        if (slash === "/review") {
          if (replState !== "idle") {
            pushSystemMsg("Cannot start a review while a response is in progress.", "error");
            return true;
          }
          const ref = parts.slice(1).join(" ").trim() || "";
          const gitArgs = ref ? ["diff", ref] : ["diff", "HEAD"];
          let diffOut = spawnSync("git", gitArgs, {
            cwd: projectRoot, encoding: "utf-8", timeout: 15_000,
          }).stdout?.trim() ?? "";

          // Fallback to staged changes if working-tree diff is empty
          if (!diffOut) {
            diffOut = spawnSync("git", ["diff", "--staged"], {
              cwd: projectRoot, encoding: "utf-8", timeout: 15_000,
            }).stdout?.trim() ?? "";
          }

          if (!diffOut) {
            pushSystemMsg(
              "No changes found to review.\n\n" +
              "Tips:\n" +
              "  - Stage or edit some files first\n" +
              "  - Use `/review HEAD~1` to review the last commit\n" +
              "  - Use `/review main..HEAD` for a range",
              "error",
            );
            return true;
          }

          const MAX_DIFF = 12_000;
          const truncated = diffOut.length > MAX_DIFF;
          const diffText  = truncated
            ? diffOut.slice(0, MAX_DIFF) + "\n\n[diff truncated — " + (diffOut.length - MAX_DIFF) + " chars omitted]"
            : diffOut;

          const reviewPrompt =
            `Please do a thorough code review of the following git diff:\n\n` +
            "```diff\n" + diffText + "\n```\n\n" +
            "Focus on:\n" +
            "1. **Correctness** — bugs, edge cases, off-by-one errors\n" +
            "2. **Security** — injections, data exposure, auth gaps\n" +
            "3. **Performance** — unnecessary work, inefficient algorithms\n" +
            "4. **Maintainability** — naming, complexity, duplication\n" +
            "5. **Tests** — missing coverage for new/changed logic\n\n" +
            "For each issue found, cite the file and line, explain the problem, and suggest a fix.";

          pushSystemMsg(`Starting code review${ref ? ` of \`${ref}\`` : " of working-tree changes"}…`);
          void sendMessage(reviewPrompt, { noTools: true });
          return true;
        }

        // ── /commit — AI-powered git commit message ──────────────────────
        if (slash === "/commit") {
          if (replState !== "idle") {
            pushSystemMsg("Cannot run /commit while a response is in progress.");
            return true;
          }

          // Prefer staged diff; fall back to HEAD diff
          let diffOut = spawnSync("git", ["diff", "--staged"], {
            cwd: projectRoot, encoding: "utf-8", timeout: 10_000,
          }).stdout?.trim() ?? "";
          const isStaged = diffOut.length > 0;

          if (!diffOut) {
            diffOut = spawnSync("git", ["diff", "HEAD"], {
              cwd: projectRoot, encoding: "utf-8", timeout: 10_000,
            }).stdout?.trim() ?? "";
          }

          if (!diffOut) {
            pushSystemMsg("No changes detected. Make some edits or stage files first.");
            return true;
          }

          const MAX_COMMIT_DIFF = 8_000;
          const diffText = diffOut.length > MAX_COMMIT_DIFF
            ? diffOut.slice(0, MAX_COMMIT_DIFF) + `\n\n[truncated — ${diffOut.length - MAX_COMMIT_DIFF} chars omitted]`
            : diffOut;

          if (!isStaged) {
            pushSystemMsg("No staged changes — using `git diff HEAD`. Run `git add` to be more precise.");
          }

          pushSystemMsg("Generating commit message…");
          chatLinesDirty = true;
          replState = "thinking";
          startTimer();
          app.requestRender();

          (async () => {
            try {
              let commitMsg = "";
              const commitPrompt =
                "Generate a git commit message for the following diff.\n" +
                "Rules:\n" +
                "- First line: imperative mood, max 72 chars (e.g. 'Fix null pointer in auth handler')\n" +
                "- Optional blank line + body if context genuinely helps\n" +
                "- NO markdown, NO code blocks, NO quotes, NO explanation — ONLY the raw commit message text\n\n" +
                "```diff\n" + diffText + "\n```";

              const stream = client.chatStream(
                [{ role: "user", content: commitPrompt }],
                { tier: "auto" },
              );

              for await (const chunk of stream) {
                if (chunk.type === "token") commitMsg += chunk.text ?? "";
              }

              commitMsg = commitMsg.trim().replace(/^[`"']+|[`"']+$/g, "");
              replState = "idle";

              if (!commitMsg) {
                pushSystemMsg("Failed to generate commit message.", "error");
                chatLinesDirty = true;
                app.requestRender();
                return;
              }

              pushSystemMsg(`Suggested commit message:\n\`\`\`\n${commitMsg}\n\`\`\``);
              chatLinesDirty = true;
              app.requestRender();

              dialog.showConfirm(
                "Commit Changes",
                `Run: git commit -m "${commitMsg.split("\n")[0]}"?`,
                () => {
                  const result = spawnSync("git", ["commit", "-m", commitMsg], {
                    cwd: projectRoot, encoding: "utf-8",
                  });
                  if ((result.status ?? 1) === 0) {
                    pushSystemMsg(`Committed.\n\`\`\`\n${result.stdout?.trim() ?? ""}\n\`\`\``);
                  } else {
                    pushSystemMsg(
                      `Git commit failed:\n${result.stderr?.trim() || result.stdout?.trim()}`,
                      "error",
                    );
                  }
                  chatLinesDirty = true;
                  app.requestRender();
                },
                () => {
                  pushSystemMsg("Commit cancelled.");
                  chatLinesDirty = true;
                  app.requestRender();
                },
              );
            } catch (err) {
              replState = "idle";
              pushSystemMsg(`/commit error: ${err instanceof Error ? err.message : String(err)}`, "error");
              chatLinesDirty = true;
              app.requestRender();
            }
          })();
          return true;
        }

        // ── /skill — prompt template skills ───────────────────────────────
        if (slash === "/skill" || slash === "/skills") {
          const arg = parts.slice(1).join(" ").trim();
          const allSkills = loadSkills(skillLoadOptions());

          // /skill list or bare /skill
          if (!arg || arg === "list") {
            if (allSkills.length === 0) {
              pushSystemMsg(
                "No skills found.\n\n" +
                "Create a skill: save a `.md` file in `.klaatai/skills/` (project) or `~/.klaatai/skills/` (global).\n" +
                "Claude Code skills in `.claude/skills/<name>/SKILL.md` are also discovered when compat is enabled.\n\n" +
                "Example: `echo '# Fix Types\\nFix all TypeScript type errors in the project.' > .klaatai/skills/fix-types.md`",
              );
            } else {
              const lines = ["**Skills available:**\n"];
              for (const s of allSkills) {
                const desc = s.description ?? s.content.split("\n")[0]!.replace(/^#+\s*/, "").slice(0, 60);
                const hint = s.argsHint ? ` \`${s.argsHint}\`` : "";
                lines.push(`  **${s.name}**${hint} *(${formatSkillLocation(s)})* — ${desc}`);
              }
              lines.push("\nUsage: `/skill <name> [args]` or directly `/<name> [args]` · `/skill new <name>` to create");
              pushSystemMsg(lines.join("\n"));
            }
            return true;
          }

          // /skill new <name>
          if (arg.startsWith("new ") || arg === "new") {
            const skillName = arg.slice(4).trim() || "my-skill";
            const skillDir  = join(projectRoot, ".klaatai", "skills");
            mkdirSync(skillDir, { recursive: true });
            const skillPath = join(skillDir, `${skillName}.md`);
            if (!existsSync(skillPath)) {
              writeFileSync(skillPath,
                `---\nname: ${skillName}\ndescription: One-line description shown in /skill list\nargs: [optional args hint]\n---\n\n` +
                `Describe what this skill should do. Reference $ARGUMENTS to use invocation args.\n`, "utf-8");
            }
            const editor = process.env.EDITOR || "nano";
            app.suspend();
            spawnSync(editor, [skillPath], { stdio: "inherit" });
            app.resume();
            pushSystemMsg(`Skill \`${skillName}\` saved to \`${skillPath}\`.`);
            return true;
          }

          // /skill <name> [args] — invoke
          const skillName = arg.split(/\s+/)[0]!.replace(/\.md$/, "");
          const skillArgs = arg.slice(skillName.length).trim();
          const match = allSkills.find(s => s.name === skillName);
          if (!match) {
            const names = allSkills.map(s => `\`${s.name}\``).join(", ") || "(none)";
            pushSystemMsg(`Skill \`${skillName}\` not found. Available: ${names}`);
            return true;
          }
          pushSystemMsg(`Invoking skill **${match.name}**${skillArgs ? ` with \`${skillArgs}\`` : ""}…`);
          void sendMessage(expandSkill(match, skillArgs));
          return true;
        }

        // ── /hooks — list configured hooks ───────────────────────────────
        if (slash === "/hooks") {
          const hooks = loadHooks();
          const events: HookEvent[] = ["before_message", "after_message", "before_tool", "after_tool"];
          const hasAny = events.some(e => (hooks[e]?.length ?? 0) > 0);
          if (!hasAny) {
            pushSystemMsg(
              "No hooks configured.\n\n" +
              "Create `.klaatai/hooks.json` or `~/.klaatai/hooks.json`:\n\n" +
              "```json\n{\n" +
              '  "after_message": ["afplay /System/Library/Sounds/Glass.aiff"],\n' +
              '  "before_tool":   ["echo \\"Tool: $KLAATAI_TOOL_NAME\\" >> /tmp/klaatai.log"],\n' +
              '  "after_tool":    ["echo \\"Done: $KLAATAI_TOOL_NAME\\" >> /tmp/klaatai.log"]\n' +
              "}\n```\n\n" +
              "**Events:** `before_message` · `after_message` · `before_tool` · `after_tool`\n" +
              "**Env vars:** `KLAATAI_EVENT` · `KLAATAI_TOOL_NAME` · `KLAATAI_TOOL_ARGS` · `KLAATAI_PROJECT_ROOT` · `KLAATAI_SESSION_ID`",
            );
          } else {
            const lines = ["**Configured hooks:**\n"];
            for (const evt of events) {
              const entries = hooks[evt] ?? [];
              if (entries.length === 0) continue;
              lines.push(`  **${evt}** (${entries.length})`);
              for (const e of entries) {
                const cmd = hookCommand(e);
                const matcher = typeof e !== "string" && e.matcher ? ` *(matcher: \`${e.matcher}\`)*` : "";
                lines.push(`    \`${cmd.slice(0, 72)}${cmd.length > 72 ? "…" : ""}\`${matcher}`);
              }
            }
            lines.push("", "v2: entries may be `{ \"command\", \"matcher\", \"timeout\" }`; hooks get a JSON payload on stdin; before_tool hooks can block (exit 2 or `{\"decision\":\"block\"}`).");
            pushSystemMsg(lines.join("\n"));
          }
          return true;
        }

        // ── Fallback: /<skill-name> [args] invokes a skill directly ──────
        {
          const name = slash.slice(1);
          const rest = parts.slice(1).join(" ").trim();
          const skill = loadSkills(skillLoadOptions()).find(s => s.name === name);
          if (skill) {
            pushSystemMsg(`Invoking skill **${skill.name}**${rest ? ` with \`${rest}\`` : ""}…`);
            void sendMessage(expandSkill(skill, rest));
            return true;
          }
        }

        return false;
      }
    }
  }

  // ─── Shell command injection (! prefix) ───────────────────────────────────

  function runShellInjection(text: string): boolean {
    if (!text.startsWith("!")) return false;
    const cmd = text.slice(1).trim();
    if (!cmd) return false;

    const result = spawnSync("sh", ["-c", cmd], {
      cwd:      projectRoot,
      encoding: "utf-8",
      timeout:  15_000,
    });
    const stdout = (result.stdout ?? "").trimEnd();
    const stderr = (result.stderr ?? "").trimEnd();
    const output = [stdout, stderr].filter(Boolean).join("\n");
    const exitCode = result.status ?? 1;

    // Show as a tool-style message in chat
    const shellMsg: ChatMessage = {
      role:        "tool",
      content:     output || "(no output)",
      toolName:    `$ ${cmd}`,
      toolSummary: exitCode === 0 ? "exit 0" : `exit ${exitCode}`,
      collapsed:   output.split("\n").length > 6,
    };
    messages.push(shellMsg);
    appendSessionMsg(shellMsg);

    // Inject into API context so AI has the output available
    apiMessages = [
      ...apiMessages,
      { role: "user",      content: `$ ${cmd}\n\n${output || "(no output)"}` },
      { role: "assistant", content: `I can see the output of \`${cmd}\`. Let me know if you'd like me to analyse or act on it.` },
    ];

    chatLinesDirty = true;
    chatAutoScroll = true;
    app.requestRender();
    return true;
  }

  async function sendMessage(text: string, opts: { noTools?: boolean } = {}): Promise<void> {
    if (!text.trim()) return;

    // ── ! shell injection ─────────────────────────────────────────────────
    if (text.trimStart().startsWith("!")) {
      if (runShellInjection(text.trimStart())) return;
    }

    if (text.startsWith("/")) {
      if (handleSlashCommand(text)) return;
    }

    if (history[0] !== text.trim()) {
      history = [text.trim(), ...history].slice(0, 200);
    }
    field.historyReset();

    // ── Resolve @ file references ──────────────────────────────────────
    // Replace @path tokens with inline file contents for context injection.
    // Pattern: @ followed by a non-space path (supports relative/absolute)
    let resolvedText = text;
    const atRefs = text.match(/@([\w./\\-]+)/g);
    if (atRefs) {
      const injections: string[] = [];
      for (const ref of atRefs) {
        const relPath = ref.slice(1); // strip @
        const absPath = resolve(projectRoot, relPath);
        if (existsSync(absPath)) {
          try {
            const contents = readFileSync(absPath, "utf-8");
            const lines = contents.split("\n").length;
            injections.push(`--- @${relPath} (${lines} lines) ---\n${contents}\n--- end @${relPath} ---`);
          } catch { /* skip unreadable */ }
        }
      }
      if (injections.length > 0) {
        resolvedText = text + "\n\n" + injections.join("\n\n");
      }
    }

    // Expand collapsed paste chips to full text for the MODEL (the transcript
    // keeps the compact "[#1 N lines pasted]" chip via `text`).
    resolvedText = expandPastes(resolvedText);
    pasteStore.clear();

    // Drain background-agent completion notes into this turn so the model
    // learns finished tasks without polling (transcript keeps the clean text).
    if (bgTaskNotices.length > 0) {
      resolvedText += `\n\n[system note] ${bgTaskNotices.join(" ")}`;
      bgTaskNotices.length = 0;
    }

    // ── Build user message content (text + pending images) ─────────────
    let userContent: string | ContentPart[];
    if (pendingImages.length > 0) {
      const imageParts: ContentPart[] = pendingImages.map(img => ({
        type: "image_url" as const,
        image_url: { url: `data:${img.mime};base64,${img.b64}` },
      }));
      userContent = [
        { type: "text" as const, text: resolvedText },
        ...imageParts,
      ];
      pendingImages = []; // consumed
    } else {
      userContent = resolvedText;
    }

    messages.push({ role: "user", content: text });
    appendSessionMsg({ role: "user", content: text });
    ledger.userAsked(text);
    chatLinesDirty = true;
    chatAutoScroll = true;

    // 9.4: per-task cost attribution — close the previous task's tally and
    // start a new one; a new user message also re-arms one round past a hit
    // budget cap (the user consciously chose to continue).
    if (currentTaskLabel !== null) {
      taskCostLog.push({ label: currentTaskLabel, cost: currentTaskCost });
      if (taskCostLog.length > 20) taskCostLog.shift();
    }
    currentTaskLabel = text.replace(/\s+/g, " ").trim().slice(0, 60);
    currentTaskCost = 0;
    budgetStop = false;
    // 9.5: fresh phase tracking per task; a new message clears a phase pause.
    phaseTracker.reset();

    // ── Tab mode system prompt (Build vs Plan) ────────────────────────────
    const tabPrompt = TAB_SYSTEM_PROMPTS[tabs.activeTab.label];
    const tabSystemMsg: Message | null = tabPrompt
      ? { role: "system", content: tabPrompt }
      : null;

    // Strip any previously-stored mode prompt, then insert the current one
    // AFTER the leading system seed (core/env/rules) so the static prefix
    // stays byte-stable across turns (prompt-cache friendly).
    const isModePrompt = (m: Message) =>
      m.role === "system" && typeof m.content === "string" &&
      Object.values(TAB_SYSTEM_PROMPTS).includes(m.content);
    const historyMsgs = apiMessages.filter(m => !isModePrompt(m));
    let seedEnd = 0;
    while (seedEnd < historyMsgs.length && historyMsgs[seedEnd]!.role === "system") seedEnd++;
    const userMsg = { role: "user" as const, content: userContent };
    const baseApiMessages = tabSystemMsg
      ? [...historyMsgs.slice(0, seedEnd), tabSystemMsg, ...historyMsgs.slice(seedEnd), userMsg]
      : [...historyMsgs, userMsg];

    const newApiMessages: Message[] = baseApiMessages;
    apiMessages  = newApiMessages;
    replState    = "thinking";
    streamBuffer = "";
    // Reset per-response write tracker for undo
    currentResponseWrites = [];
    runHooks("before_message", { KLAATAI_USER_MESSAGE: text });
    startTimer();
    app.requestRender();

    try {
      const planMode = tabs.activeTab.label === "Plan";
      // Dialect fixed per turn from the tier we expect to be served (pinned
      // or last seen). Plan mode keeps its own read-only set — the server's
      // plan cascade picks the tier there.
      const dialect = activeDialect();
      const tools: ToolDefinition[] = opts.noTools ? [] : planMode
        ? [
            ...TOOL_DEFINITIONS.filter(t => PLAN_READONLY_TOOLS.has(t.function.name)),
            EXIT_PLAN_TOOL,
          ]
        : [
            ...toolsForDialect(dialect, TOOL_DEFINITIONS),
            ...(dialectIncludesExtras(dialect)
              ? [...mcpManager.toolDefinitions, ...pluginRegistry.toolDefinitions]
              : []),
          ];
      let fullText = "";
      let currentApiMessages = [...newApiMessages];
      // 9.4: per-response doom-loop signal (reset each round).
      let turnLoopSignal: import("../api/client.js").LoopSignal | null = null;

      interrupted = false;

      outerLoop: while (true) {
        if (interrupted) break outerLoop;
        replState    = "thinking";
        streamBuffer = "";
        fullText     = "";
        turnLoopSignal = null;
        chatLinesDirty = true;
        app.requestRender();

        // Pre-send check: if real token count from last call exceeded budget,
        // compact the stored messages BEFORE building the send array.
        if (lastContextSize > SAFE_CONTEXT_BUDGET && currentApiMessages.length > 8) {
          currentApiMessages = compactMessagesForApi(currentApiMessages, getContextWindow(), compactOpts());
        }

        const stream = client.chatStream(
          compactMessagesForApi(currentApiMessages, getContextWindow(), compactOpts()),
          {
            tools: tools.length > 0 ? tools : undefined,
            tier: forceTier ?? undefined,
            // D4 task-shape hint: plan mode routes to the plan-clamped cascade.
            task: planMode ? "plan" : undefined,
          },
        );
        let pendingToolCalls: ToolCall[] | null = null;

        for await (const chunk of stream) {
          if (interrupted) break;
          switch (chunk.type) {
            case "token":
              if (replState !== "streaming") {
                // Start typing reveal on first token
                streamRevealLen = 0;
                streamRevealDone = false;
                if (streamRevealTimer) clearInterval(streamRevealTimer);
                streamRevealTimer = setInterval(() => {
                  streamRevealLen += 3;
                  if (streamRevealLen >= 120 || streamRevealLen >= streamBuffer.length) {
                    streamRevealDone = true;
                    if (streamRevealTimer) { clearInterval(streamRevealTimer); streamRevealTimer = null; }
                  }
                  app.requestRender();
                }, 50);
              }
              replState     = "streaming";
              fullText     += chunk.text ?? "";
              streamBuffer  = fullText;
              chatLinesDirty = true;
              chatAutoScroll = true;
              app.requestRender();
              break;
            case "tool_call":
              pendingToolCalls = chunk.tool_calls ?? null;
              break;
            case "quota":
              if (chunk.quota) lastQuota = chunk.quota;
              break;
            case "metadata":
              if (chunk.metadata && chunk.usage) {
                const cost = KlaatAIClient.formatCost(chunk.metadata, chunk.usage);
                lastMeta = { metadata: chunk.metadata, cost, usage: chunk.usage };
                lastModel = chunk.metadata.model ?? "Auto";
                lastTier  = chunk.metadata.tier ?? "smart";
                lastClamp = parseClamp(chunk.metadata.reason);
                const [inp, out] = TIER_COSTS[chunk.metadata.tier] ?? [0.5, 1.5];
                const turnCost = (chunk.usage.prompt_tokens * inp + chunk.usage.completion_tokens * out) / 1_000_000;
                sessionCost += turnCost;
                recordTurnCost(turnCost);
                totalTokens = {
                  prompt:     totalTokens.prompt     + chunk.usage.prompt_tokens,
                  completion: totalTokens.completion + chunk.usage.completion_tokens,
                };
                lastContextSize = chunk.usage.prompt_tokens;
                totalRequests++;
                const recordedTier = forceTier ?? lastTier;
                tierCounts.set(recordedTier, (tierCounts.get(recordedTier) ?? 0) + 1);
                // 9.4: doom-loop signal for THIS response (D6 wire contract).
                turnLoopSignal = chunk.metadata.loop_signal ?? null;
                checkBudgetGuards();
                // 9.5: attribute this response to the current phase.
                checkPhaseBudget(chunk.usage.total_tokens
                  ?? chunk.usage.prompt_tokens + chunk.usage.completion_tokens);
              }
              break;
            case "done":
              break;
            case "error": {
              messages.push({
                role: "assistant", content: `Error: ${chunk.error}`, kind: "error",
              });
              chatLinesDirty = true;
              replState    = "idle";
              streamBuffer = "";
              stopTimer();
              app.requestRender();
              break outerLoop;
            }
          }
        } // end for-await

        // 9.4/9.5: budget hard-cap or phase pause — finish rendering this
        // response but run no further agent rounds this turn.
        if ((budgetStop || phaseTracker.paused) && pendingToolCalls && pendingToolCalls.length > 0) {
          messages.push({
            role: "system", kind: "error",
            content: budgetStop
              ? "⛔ Pending tool calls skipped — session cost cap reached (see message above)."
              : "⛔ Pending tool calls skipped — exploration budget exhausted with no artifact (see message above).",
          });
          chatLinesDirty = true;
          break;
        }

        if (pendingToolCalls && pendingToolCalls.length > 0) {
          replState = "tool";
          const cleanedToolText = stripStrayTextToolCallArtifacts(
            (fullText || "").replace(/<(?:thinking|reasoning)>[\s\S]*?<\/(?:thinking|reasoning)>/g, "")
          ).trim();
          currentApiMessages = [
            ...currentApiMessages,
            { role: "assistant", content: cleanedToolText, tool_calls: pendingToolCalls },
          ];

          // 9.4: server doom-loop reaction (D6). results_identical means the
          // model just repeated the same tool round with identical args AND
          // got identical results before — executing it again is pure waste.
          // Refuse the round, hand back recovery guidance as the tool result
          // (role "tool" continuations are quota-free), and let it rethink.
          if (turnLoopSignal?.results_identical) {
            loopRefusals++;
            const names = [...new Set(pendingToolCalls.map(t => t.function.name))].join(", ");
            if (loopRefusals >= 3) {
              messages.push({
                role: "system", kind: "error",
                content:
                  `⛔ Stopped: the model repeated the same tool round (${names}) even after ` +
                  `${loopRefusals - 1} recovery prompts. Rephrase the request or give it a hint about what to try instead.`,
              });
              chatLinesDirty = true;
              break;
            }
            const guidance =
              `Refused: doom-loop detected (server signal). You have called ${names} with identical ` +
              `arguments ${turnLoopSignal.count}+ times and received identical results each time. ` +
              `Do NOT repeat this call. Change approach: re-read the last error carefully, question your ` +
              `assumption about the file/command state, try a different tool, or ask the user with ask_user.`;
            for (const tc of pendingToolCalls) {
              currentApiMessages = [
                ...currentApiMessages,
                { role: "tool", content: guidance, tool_call_id: tc.id },
              ];
            }
            messages.push({
              role: "system",
              content: `↻ Doom loop detected (${names} × ${turnLoopSignal.count}) — round refused, recovery guidance injected.`,
            });
            chatLinesDirty = true;
            app.requestRender();
            continue;
          }
          if (turnLoopSignal && !turnLoopSignal.results_identical) {
            // Weak signal (same calls, differing results) — warn only.
            messages.push({
              role: "system",
              content: `⚠ Repetitive tool pattern noticed by the server (${turnLoopSignal.count}× similar rounds) — watching for a loop.`,
            });
            chatLinesDirty = true;
          }
          loopRefusals = 0;

          // Partition consecutive read-only tools into concurrent batches
          // (order preserved). Mutating/prompting tools always run alone, so
          // permission prompts never collide. Read-only delegations
          // (explore/review) batch too — parallel sub-agent fan-out.
          const isBatchable = (t: ToolCall) =>
            SAFE_TOOLS.has(t.function.name) ||
            (t.function.name === "delegate_task" && getPersona(parseDelegateArgs(t).agent).readonly);
          const batches: ToolCall[][] = [];
          for (const tc of pendingToolCalls) {
            const last = batches[batches.length - 1];
            if (isBatchable(tc) && last && isBatchable(last[0]!)) {
              last.push(tc);
            } else {
              batches.push([tc]);
            }
          }

          for (const batch of batches) {
          const batchResults = batch.length === 1
            ? [await executeWithPermission(batch[0]!)]
            : await Promise.all(batch.map(b => executeWithPermission(b)));
          app.requestRender();

          for (let bi = 0; bi < batch.length; bi++) {
            const tc = batch[bi]!;
            const toolResult = batchResults[bi]!;
            const toolLines = toolResult.split("\n").length;
            const editDiff = toolResult.startsWith("Error") ? undefined : diffForTool(tc);
            const toolMsg: ChatMessage = {
              role:        "tool",
              content:     toolResult,
              toolName:    tc.function.name,
              toolSummary: summarizeTool(tc),
              collapsed:   editDiff ? false : toolLines > 6,
              diff:        editDiff?.diff,
              diffPath:    editDiff?.path,
            };
            messages.push(toolMsg);
            appendSessionMsg(toolMsg);
            chatLinesDirty = true;

            // Breadcrumb: track the last file the AI touched
            const FILE_TOOLS = new Set(["read_file", "edit_file", "write_file", "multi_edit", "file_outline"]);
            if (FILE_TOOLS.has(tc.function.name)) {
              try {
                const a = JSON.parse(tc.function.arguments) as { path?: string };
                if (a.path) {
                  lastActiveFile = a.path.replace(projectRoot + "/", "").replace(process.env.HOME ?? "", "~");
                  lastActiveFileTime = Date.now();
                }
              } catch { /* */ }
            }

            // Ledger: record command outcomes (mechanical, no LLM cost)
            if (tc.function.name === "run_command" && !toolResult.startsWith("Error")) {
              try {
                const cmd = String((JSON.parse(tc.function.arguments) as { command?: string }).command ?? "");
                const exitM = toolResult.match(/^\[exit (\d+)\]/);
                if (cmd) ledger.commandRun(cmd, exitM ? Number(exitM[1]) : 0);
              } catch { /* ignore */ }
            }

            // Report edit-tool quality to Klaatu health (E3). Blame the model
            // that emitted this turn (x_klaatai.model) — never guess. Carried
            // on the next chat request's X-KlaatAI-Model-Feedback header.
            if (tc.function.name === "edit_file" || tc.function.name === "multi_edit") {
              const blame = lastMeta?.metadata.model;
              if (blame) {
                if (toolResult.startsWith("Error")) {
                  client.queueFeedback({
                    model_id: blame, error_type: "edit_failure",
                    tier: lastMeta?.metadata.tier, detail: "cascade exhausted",
                  });
                } else {
                  const via = toolResult.match(/matched via ([\w-]+)/);
                  if (via && via[1] !== "exact") {
                    client.queueFeedback({
                      model_id: blame, error_type: "edit_fuzzy_rescue",
                      tier: lastMeta?.metadata.tier, pass: via[1],
                    });
                  }
                }
              }
            }

            // Track modified files from tool results (for sidebar + /undo)
            if (tc.function.name === "write_file" || tc.function.name === "edit_file" || tc.function.name === "multi_edit" || tc.function.name === "apply_patch") {
              try {
                const args = JSON.parse(tc.function.arguments);
                let touched: { path: string; kind: "write" | "edit" }[] = [];
                if (tc.function.name === "apply_patch") {
                  const parsed = parsePatch(String(args.patch ?? ""));
                  if (parsed.ok) {
                    for (const op of parsed.ops) {
                      if (op.type === "add") touched.push({ path: op.path, kind: "write" });
                      else if (op.type === "update") {
                        touched.push({ path: op.path, kind: "edit" });
                        if (op.moveTo) touched.push({ path: op.moveTo, kind: "write" });
                      }
                      // deletes: git checkout on /undo restores them via the same path list
                      else touched.push({ path: op.path, kind: "edit" });
                    }
                  }
                } else {
                  const filePath = args.path ?? args.file_path ?? "";
                  if (filePath) touched = [{ path: filePath, kind: tc.function.name === "write_file" ? "write" : "edit" }];
                }
                for (const t of touched) {
                  if (!toolResult.startsWith("Error")) {
                    ledger.fileWritten(t.path, t.kind);
                  }
                  const absPath = resolve(projectRoot, t.path);
                  const existing = modifiedFiles.find(f => f.path === t.path);
                  if (existing) {
                    existing.additions += 1;
                  } else {
                    modifiedFiles.push({ path: t.path, additions: 1, deletions: 0 });
                  }
                  // Track for undo
                  if (!currentResponseWrites.includes(absPath)) {
                    currentResponseWrites.push(absPath);
                  }
                }
              } catch { /* ignore parse errors */ }
            }

            currentApiMessages = [
              ...currentApiMessages,
              { role: "tool", content: truncateToolResult(toolResult), tool_call_id: tc.id },
            ];
            app.requestRender();
          }
          }
          if (interrupted) break outerLoop;
          // 9.5: reclassify the agent phase from this round's tools.
          phaseTracker.noteTools(pendingToolCalls.map(t => t.function.name));
          continue;
        }
        break;
      }

      if (interrupted) {
        messages.push({ role: "system", content: "⏹ Interrupted by user.", kind: "error" });
        chatLinesDirty = true;
        interrupted = false;
      } else if (fullText.trim()) {
        // Extract <thinking> blocks from the response
        const thinkMatch = fullText.match(/<(?:thinking|reasoning)>([\s\S]*?)<\/(?:thinking|reasoning)>/);
        const thinkContent = thinkMatch ? thinkMatch[1]!.trim() : undefined;
        const cleanContent = stripStrayTextToolCallArtifacts(
          fullText.replace(/<(?:thinking|reasoning)>[\s\S]*?<\/(?:thinking|reasoning)>/g, "")
        ).trim();

        const assistantMsg: ChatMessage = {
          role: "assistant",
          content: cleanContent || fullText,
          thinking: thinkContent,
          model: lastModel,
          tier: lastTier,
          clamp: lastClamp ?? undefined,
          elapsed,
        };
        messages.push(assistantMsg);
        appendSessionMsg(assistantMsg);
        apiMessages = [...currentApiMessages, { role: "assistant", content: cleanContent || fullText }];
        runHooks("after_message", { KLAATAI_ASSISTANT_RESPONSE: fullText.slice(0, 500) });
        chatLinesDirty = true;
        chatAutoScroll = true;

        // Commit undo snapshot if AI wrote any files this turn
        if (currentResponseWrites.length > 0) {
          undoStack.push([...currentResponseWrites]);
          // Keep at most 20 undo levels
          if (undoStack.length > 20) undoStack.shift();
          currentResponseWrites = [];
        }

        // Auto-compact when actual context exceeds the safe budget.
        // Uses SAFE_CONTEXT_BUDGET (60K) since the router can switch models
        // between calls and some models have very small context windows (nano=16K, fast=32K).
        if (apiMessages.length > 8 && lastContextSize > SAFE_CONTEXT_BUDGET) {
          void compactContext();
        }

        // Refresh lifetime usage stats in background (non-blocking)
        lifetimeStatsAge++;
        if (lifetimeStatsAge % 3 === 0 || lifetimeStats === null) {
          void fetchLifetimeStats();
        }
      }
    } catch (err) {
      messages.push({
        role:    "assistant",
        content: `Error: ${err instanceof Error ? err.message : String(err)}`,
        kind:    "error",
      });
      chatLinesDirty = true;
    }

    // Plan mode exited this turn — show the plan and switch to Build so the
    // next turn implements with the full toolset.
    if (pendingPlanExit !== null) {
      const plan = pendingPlanExit;
      pendingPlanExit = null;
      if (tabs.activeTab.label === "Plan") tabs.setActive(0); // Build
      messages.push({
        role: "assistant",
        content: `**Plan approved — switched to Build mode.**\n\n${plan}`,
      });
      ledger.note("plan approved, switched to Build");
      chatLinesDirty = true;
    }

    replState    = "idle";
    streamBuffer = "";
    stopTimer();
    app.requestRender();
  }

  // ─── Context compaction ───────────────────────────────────────────────────

  let consecutiveCompactFailures = 0;
  let compactionCount = 0; // 9.6: shown in /context

  async function compactContext(): Promise<void> {
    if (apiMessages.length < 6) return;
    // Circuit breaker — a broken backend or model must not trigger a
    // compact→fail→compact loop that burns requests.
    if (consecutiveCompactFailures >= MAX_CONSECUTIVE_COMPACT_FAILURES) return;
    // Keep the leading system seed (core/env/rules) out of the summary and intact.
    let seedEnd = 0;
    while (seedEnd < apiMessages.length && apiMessages[seedEnd]!.role === "system") seedEnd++;
    const systemSeed  = apiMessages.slice(0, seedEnd);
    const toSummarise = apiMessages.slice(seedEnd, -4);
    if (toSummarise.length === 0) return;
    // Flatten to plain text: the slice can cut assistant/tool pairings, and
    // orphaned tool messages make providers reject the whole request (which
    // surfaced as "empty compaction summary"). The summary doesn't need tool
    // structure — just the content.
    const flattened: Message[] = toSummarise.map(m => {
      if (m.role === "tool") {
        const c = typeof m.content === "string" ? m.content : "";
        return { role: "user" as const, content: `[tool result]\n${c.slice(0, 600)}` };
      }
      if (m.role === "assistant" && m.tool_calls?.length) {
        const calls = m.tool_calls.map(t => t.function.name).join(", ");
        const c = typeof m.content === "string" ? m.content : "";
        return { role: "assistant" as const, content: `${c}\n[called tools: ${calls}]`.trim() };
      }
      return m;
    });
    const summaryRequest: Message[] = [
      ...flattened,
      { role: "user", content: COMPACTION_PROMPT },
    ];
    // 9.6: externalize critical state BEFORE the lossy step — this is what
    // the post-compaction self-check verifies against, and what a later model
    // reads from the ledger if the check reports loss.
    const criticalState = collectCriticalState(toSummarise, modifiedFiles.map(f => f.path));
    ledger.sessionState(criticalState);
    try {
      replState    = "thinking";
      streamBuffer = "";
      startTimer();
      app.requestRender();

      let summaryText = "";
      let streamError: string | null = null;
      // "code" tier, not nano: the request carries the whole history being
      // summarized, and the server's nano context budget (8K) would truncate
      // exactly what we're asking it to summarize. See Klaatu proposal P1-5.
      const stream = client.chatStream(summaryRequest, { tier: "code", task: "summarize" });
      for await (const chunk of stream) {
        if (chunk.type === "error") {
          streamError = chunk.error ?? "stream error";
        } else if (chunk.type === "token") {
          summaryText  += chunk.text ?? "";
          streamBuffer  = summaryText;
          chatLinesDirty = true;
          chatAutoScroll = true;
          app.requestRender();
        } else if (chunk.type === "metadata" && chunk.usage) {
          totalTokens = {
            prompt:     totalTokens.prompt     + chunk.usage.prompt_tokens,
            completion: totalTokens.completion + chunk.usage.completion_tokens,
          };
          const [inp, out] = TIER_COSTS["code"] ?? [0.5, 1.5];
          const compactCost = (chunk.usage.prompt_tokens * inp + chunk.usage.completion_tokens * out) / 1_000_000;
          sessionCost += compactCost;
          recordTurnCost(compactCost);
        }
      }

      if (streamError) throw new Error(streamError);
      const summary = extractSummary(summaryText);
      if (!summary) throw new Error("empty compaction summary");
      consecutiveCompactFailures = 0;

      // Keep compacted details recoverable: full summary goes to the ledger,
      // and the in-context stub points any future (possibly different) model at it.
      ledger.compacted(summary);

      // 9.6: post-compaction self-check — did the summary drop the task
      // intent or the files being worked on? If so, say so IN CONTEXT so the
      // model knows what it forgot and where to recover it.
      const missing = checkSummaryCoverage(summary, criticalState);
      const recoveryNote = missing.length
        ? `\n[Compaction check: the summary above may have LOST ${missing.join("; ")}. ` +
          `Before continuing, read_file ${ledger.path} (section "Session state") to recover it.]`
        : "";
      compactionCount++;

      // Replace apiMessages: [system seed, summary stub, last 4]
      const last4  = apiMessages.slice(-4);
      apiMessages  = [
        ...systemSeed,
        {
          role: "assistant",
          content:
            `[Context compacted — structured summary of earlier conversation below. ` +
            `Resume the task without acknowledging this summary.]\n${summary}\n` +
            `(Earlier details recoverable: read_file ${ledger.path})` +
            recoveryNote,
        },
        ...last4,
      ];

      const noticeMsg: ChatMessage = {
        role: "assistant",
        content: `**Context compacted.** Earlier conversation summarised:\n\n${summary}`,
      };
      messages.push(noticeMsg);
      if (missing.length) {
        messages.push({
          role: "system",
          content: `⚠ Compaction self-check: possible context loss — ${missing.join("; ")}. Recovery note injected (details in the session ledger).`,
        });
      }
      chatLinesDirty = true;
      chatAutoScroll = true;
    } catch (err) {
      consecutiveCompactFailures++;
      messages.push({
        role: "assistant",
        content:
          `Error compacting context: ${err instanceof Error ? err.message : String(err)}` +
          (consecutiveCompactFailures >= MAX_CONSECUTIVE_COMPACT_FAILURES
            ? "\nAuto-compaction disabled after repeated failures — use /compact to retry manually."
            : ""),
        kind: "error",
      });
      chatLinesDirty = true;
    }
    replState    = "idle";
    streamBuffer = "";
    if (streamRevealTimer) { clearInterval(streamRevealTimer); streamRevealTimer = null; }
    streamRevealDone = true;
    stopTimer();
    app.requestRender();
  }

  // ─── Render ───────────────────────────────────────────────────────────────

  const busy = () => replState !== "idle" && replState !== "permission";

  function render(buf: CellBuffer, area: Rect): void {
    const SIDEBAR_W = 36;
    const STATUS_H  = 1;
    const FOOTER_H  = 1;
    const META_H    = 1;
    const GAP_H     = 1;
    const MAX_INPUT_ROWS = 10; // auto-grow ceiling; scrolls internally beyond
    // INPUT_BOX_H / INPUT_TOTAL are computed below once the input width is known
    // (the box auto-grows to fit the wrapped input, up to MAX_INPUT_ROWS).

    hitGrid.clear();

    const isBusy = busy();

    // ── Main split: [content | status bar at bottom]
    const [contentArea, statusArea] = takeBottom(area, STATUS_H);

    // ── Content split: [chat+input | sidebar]
    const showSidebar = sidebarOverride !== null ? sidebarOverride : area.width > 80;
    const sideW = showSidebar ? SIDEBAR_W : 0;
    const chatW = contentArea.width - sideW;

    const chatPanelR: Rect = { x: contentArea.x, y: contentArea.y, width: chatW, height: contentArea.height };
    const sidebarR: Rect   = { x: contentArea.x + chatW, y: contentArea.y, width: sideW, height: contentArea.height };

    // Rail column positions
    const colL = chatPanelR.x;
    const colS = showSidebar ? sidebarR.x : -1;
    const colR = area.width - 1;

    // ── Auto-grow the input box to fit the wrapped input (1..MAX rows) ────
    const inputInnerLeft0 = colL + 3;
    const inputInnerW0    = (showSidebar ? colS : colR) - 1 - inputInnerLeft0;
    let innerRows: number;
    const PERM_CARD_H = permRequest ? 4 : 0; // separate card above input when permission pending
    if (isBusy) innerRows = 1;
    else if (askRequest) innerRows = Math.min(8, askRequest.options.length + 2);
    else if (permRequest) innerRows = 1; // input locked — permission card floats above
    else innerRows = Math.max(1, Math.min(MAX_INPUT_ROWS, field.visualRowCount(inputInnerW0 - 2)));
    const INPUT_BOX_H = innerRows + 2;               // + top/bottom border rows
    const INPUT_TOTAL = INPUT_BOX_H + META_H + GAP_H + FOOTER_H + PERM_CARD_H;

    // ── Chat panel split: [scrollable chat | input+meta+footer bottom]
    const [chatBodyR, inputAreaR] = takeBottom(chatPanelR, INPUT_TOTAL);

    // ── Chat content area
    const chatInner: Rect = {
      x: colL + 2,
      y: chatBodyR.y + 1,
      width: (showSidebar ? colS : colR) - colL - 3,
      height: chatBodyR.height - 1,
    };

    const chatLines = rebuildChatLines(chatInner.width);
    if (chatAutoScroll) {
      chatSV.scrollToBottom(chatLines.length, chatInner.height);
    }

    const info = chatSV.info(chatLines.length, chatInner.height);
    lastChatInnerY = chatInner.y;
    lastScrollTop = info.scrollTop;

    // Compute selection line-index range for highlight
    let selLineA = -1;
    let selLineB = -1;
    if (mouseSelStartY !== null && mouseCurrentY !== null) {
      const a = lastScrollTop + (Math.min(mouseSelStartY, mouseCurrentY) - chatInner.y);
      const b = lastScrollTop + (Math.max(mouseSelStartY, mouseCurrentY) - chatInner.y);
      selLineA = Math.max(0, a);
      selLineB = Math.min(chatLines.length - 1, b);
    }

    if (themePicker) {
      // ── Interactive theme picker overlay ──────────────────────────────
      hideCursor();
      const tp = themePicker;
      let ty = chatInner.y + 1;
      drawStyledLine(buf, chatInner, ty, [
        span("✦ ", { fg: palette.accent, bold: true }),
        span("Theme", { fg: "white", bold: true }),
      ]);
      ty++;
      drawStyledLine(buf, chatInner, ty, [
        span(`  Available themes (current: ${activeTheme}):`, { fg: palette.mutedFg }),
      ]);
      ty += 2;
      for (let i = 0; i < THEME_NAMES.length; i++) {
        if (ty >= chatInner.y + chatInner.height - 2) break;
        const t = THEME_NAMES[i]!;
        const isCurrent = t === activeTheme;
        const isFocused = i === tp.cursor;
        const tPalette = getPalette(t);
        const marker = isFocused ? "▶ " : "  ";
        drawStyledLine(buf, chatInner, ty, [
          span("    ", {}),
          span(marker, { fg: isFocused ? palette.accent : palette.mutedFg, bold: isFocused }),
          span(t, { fg: tPalette.accent, bold: isFocused || isCurrent }),
          span(" — ", { fg: palette.mutedFg }),
          span(THEME_DESCRIPTIONS[t], { fg: isFocused ? 252 : palette.mutedFg }),
          ...(isCurrent ? [span("  ●", { fg: 114 })] : []),
        ]);
        ty++;
      }
      ty += 1;
      if (ty < chatInner.y + chatInner.height) {
        drawStyledLine(buf, chatInner, ty, [
          span("  ↑↓ navigate · enter select · esc cancel", { fg: palette.mutedFg }),
        ]);
      }
    } else if (messages.length === 0 && !isBusy) {
      // Full-screen welcome card fills the chat body while empty.
      drawWelcomeCard(buf, chatBodyR, {
        palette, version: APP_VERSION, userLabel, projectRoot, hasProjectRules,
      });
    } else {
      // How many bottom rows to reserve for an edit-permission diff preview.
      const permDiff = permRequest?.diff;
      const previewH = permDiff && permDiff.length > 0
        ? Math.min(permDiff.length + 2, Math.floor(chatInner.height / 2))
        : 0;
      const visibleRows = chatInner.height - previewH;

      // Clear the chat area to prevent stale characters (e.g. after permission card dismissal)
      for (let row = 0; row < chatInner.height; row++) {
        for (let c = chatInner.x; c < chatInner.x + chatInner.width; c++) {
          buf.set(chatInner.y + row, c, " ", {});
        }
      }

      for (let row = 0; row < visibleRows; row++) {
        const lineIdx = info.scrollTop + row;
        const line = chatLines[lineIdx];
        if (line && line.length > 0) {
          const isSelected = lineIdx >= selLineA && lineIdx <= selLineB;
          drawStyledLine(buf, chatInner, chatInner.y + row, line,
            isSelected ? { highlightBg: 236 } : {},
          );
        }
      }

      // Edit-permission diff preview, pinned just above the input card.
      if (permDiff && previewH > 0) {
        const gy = chatInner.y + visibleRows;
        const path = permRequest?.diffPath ?? "";
        drawStyledLine(buf, chatInner, gy, [
          span("╭─ ", { fg: palette.border }),
          span(path || "changes", { fg: "white", bold: true }),
          span(" ", {}),
          span("─".repeat(Math.max(0, chatInner.width - stringWidth(path) - 6)), { fg: palette.border }),
        ]);
        const shown = permDiff.slice(0, previewH - 2);
        for (let i = 0; i < shown.length; i++) {
          drawStyledLine(buf, chatInner, gy + 1 + i, diffRow(shown[i]!, chatInner.width));
        }
        drawStyledLine(buf, chatInner, gy + previewH - 1, [
          span("╰" + "─".repeat(Math.max(0, chatInner.width - 1)), { fg: palette.border }),
        ]);
      }
    }

    // ═══════════════════════════════════════════════════════════════════
    // PERMISSION CARD (floating above input when permission is pending)
    // ═══════════════════════════════════════════════════════════════════

    if (permRequest && PERM_CARD_H > 0) {
      const pr = permRequest;
      const pcY = inputAreaR.y;
      const pcInnerLeft = colL + 3;
      const pcInnerW = (showSidebar ? colS : colR) - 1 - pcInnerLeft;

      // Top border with accent color
      const pcRight = (showSidebar ? colS : colR) - 1;
      buf.write(pcY, colL + 1, "╭", { fg: palette.accent });
      for (let c = colL + 2; c < pcRight; c++) {
        buf.write(pcY, c, "─", { fg: palette.accent });
      }
      buf.write(pcY, pcRight, "╮", { fg: palette.accent });
      // Bottom border dim
      buf.write(pcY + PERM_CARD_H - 1, colL + 1, "╰", { fg: palette.border });
      for (let c = colL + 2; c < pcRight; c++) {
        buf.write(pcY + PERM_CARD_H - 1, c, "─", { fg: palette.border });
      }
      buf.write(pcY + PERM_CARD_H - 1, pcRight, "╯", { fg: palette.border });

      // Row 1: question + target
      const PERM_QUESTIONS: Record<string, string> = {
        run_command:   "Run this command?",
        write_file:    "Create / overwrite this file?",
        edit_file:     "Apply this edit?",
        multi_edit:    "Apply these edits?",
        apply_patch:   "Apply this patch?",
        delegate_task: "Run this sub-agent?",
        web_fetch:     "Fetch this URL?",
      };
      const question = PERM_QUESTIONS[pr.tool] ?? `Allow ${pr.tool}?`;
      const rawDetail = pr.summary.replace(/^\S+\s+/, "");
      // If detail is just the tool name repeated or empty, don't show it
      const detail = (rawDetail === pr.tool || rawDetail === pr.summary) ? "" : rawDetail;
      const qR: Rect = { x: pcInnerLeft, y: pcY + 1, width: pcInnerW, height: 1 };
      const detailMaxW = qR.width - stringWidth(question) - 6;
      const detailSpans: Span[] = !detail ? [] :
        pr.tool === "run_command"
          ? highlightCommand(detail, detailMaxW)
          : (pr.tool === "edit_file" || pr.tool === "write_file" || pr.tool === "multi_edit")
            ? highlightPath(detail, detailMaxW)
            : [span(detail.length > detailMaxW ? detail.slice(0, detailMaxW - 1) + "…" : detail, { fg: 81 })];
      drawStyledLine(buf, qR, qR.y, [
        span("⚡ ", { fg: 222, bold: true }),
        span(question, { fg: "white", bold: true }),
        ...(detailSpans.length > 0 ? [span("  ", {}), ...detailSpans] : []),
      ]);

      // Row 2: text-style buttons (no background fills)
      const btnY = pcY + 2;
      const BTNS = [
        { id: "perm:yes",     label: "Yes",     key: "y", color: 114 },
        { id: "perm:no",      label: "No",      key: "n", color: 204 },
        { id: "perm:session", label: "Session", key: "s", color: 75  },
        { id: "perm:always",  label: "Always",  key: "a", color: 222 },
      ];
      let bx = pcInnerLeft;
      for (let i = 0; i < BTNS.length; i++) {
        const b = BTNS[i]!;
        const focused = permSelected === i;
        const lbl = `${b.label}`;
        const pill: StyledLine = [
          span(focused ? "❯ " : "  ", { fg: focused ? b.color : 240, bold: true }),
          span(lbl, { fg: focused ? b.color : 245, bold: focused }),
          span(` ·${b.key}`, { fg: focused ? b.color : 240 }),
          span("  ", {}),
        ];
        const pw = 2 + lbl.length + 3 + 2;
        const pr2: Rect = { x: bx, y: btnY, width: pcInnerW - (bx - pcInnerLeft), height: 1 };
        drawStyledLine(buf, pr2, btnY, pill);
        hitGrid.addRow(b.id, btnY, bx, pw, 0, "");
        bx += pw;
      }
      // Right-aligned hint
      const hint = "tab move · enter select · esc deny";
      const hintW = stringWidth(hint);
      const hintX = pcInnerLeft + pcInnerW - hintW;
      if (hintX > bx + 2) {
        drawStyledLine(buf, { x: hintX, y: btnY, width: hintW, height: 1 }, btnY, [
          span(hint, { fg: 240 }),
        ]);
      }
    }

    // ═══════════════════════════════════════════════════════════════════
    // INPUT AREA
    // ═══════════════════════════════════════════════════════════════════

    const inputBoxY = inputAreaR.y + PERM_CARD_H;
    const inputInnerLeft  = colL + 3;
    const inputInnerRight = (showSidebar ? colS : colR) - 1;
    const inputInnerW     = inputInnerRight - inputInnerLeft;

    const inputBg = palette.inputBg;
    // Box background — the meta row below stays on the default background so
    // the input box reads as a distinct card.
    for (let r = inputBoxY; r < inputBoxY + INPUT_BOX_H; r++) {
      for (let c = colL + 1; c < (showSidebar ? colS : colR); c++) {
        buf.set(r, c, " ", { bg: inputBg });
      }
    }
    // Rounded top/bottom edges for the card
    const boxRight = (showSidebar ? colS : colR) - 1;
    buf.write(inputBoxY, colL + 1, "╭", { fg: palette.border, bg: inputBg });
    buf.write(inputBoxY + INPUT_BOX_H - 1, colL + 1, "╰", { fg: palette.border, bg: inputBg });
    for (let c = colL + 2; c < boxRight; c++) {
      buf.write(inputBoxY, c, "─", { fg: palette.border, bg: inputBg });
      buf.write(inputBoxY + INPUT_BOX_H - 1, c, "─", { fg: palette.border, bg: inputBg });
    }
    buf.write(inputBoxY, boxRight, "╮", { fg: palette.border, bg: inputBg });
    buf.write(inputBoxY + INPUT_BOX_H - 1, boxRight, "╯", { fg: palette.border, bg: inputBg });

    const boxR = { inputBoxY, bottomY: inputBoxY + INPUT_BOX_H - 1 };

    // ── Slash-command suggestions, pinned above the input card ─────────────
    if (slashSuggest && replState === "idle" && !permRequest && !askRequest && !dialog.active) {
      const rows = Math.min(slashSuggest.items.length, Math.max(0, inputBoxY - 1));
      const startY = inputBoxY - rows;
      const cmdW = Math.max(...slashSuggest.items.map(s => stringWidth(s.cmd))) + 2;
      for (let i = 0; i < rows; i++) {
        const it = slashSuggest.items[i]!;
        const sel = i === slashSuggest.selected;
        const y = startY + i;
        const rowBg = sel ? 238 : 235;
        for (let c = colL + 1; c < (showSidebar ? colS : colR); c++) buf.set(y, c, " ", { bg: rowBg });
        const desc = it.desc.length > inputInnerW - cmdW - 4 ? it.desc.slice(0, inputInnerW - cmdW - 5) + "…" : it.desc;
        drawStyledLine(buf, { x: inputInnerLeft, y, width: inputInnerW, height: 1 }, y, [
          span(sel ? "❯ " : "  ", { fg: palette.accent, bold: true, bg: rowBg }),
          span(it.cmd.padEnd(cmdW), { fg: sel ? "white" : 252, bold: sel, bg: rowBg }),
          span(desc, { fg: 245, bg: rowBg }),
        ]);
      }
      if (rows > 0) {
        // Right-aligned key hint on the first suggestion row.
        const hint = "↑↓ move · tab complete · enter run · esc dismiss";
        const hintW = stringWidth(hint);
        const hintX = inputInnerLeft + inputInnerW - hintW;
        if (hintX > inputInnerLeft + cmdW + 30) {
          drawStyledLine(buf, { x: hintX, y: startY, width: hintW, height: 1 }, startY, [
            span(hint, { fg: 240, bg: slashSuggest.selected === 0 ? 238 : 235 }),
          ]);
        }
      }
    }

    const fieldInnerR: Rect = {
      x: inputInnerLeft,
      y: inputBoxY + Math.floor(INPUT_BOX_H / 2),
      width: inputInnerW,
      height: 1,
    };

    lastFieldRect = null; // set only when the editable field renders (idle)
    if (askRequest) {
      hideCursor();
      const aq = askRequest;
      const qy = inputBoxY + 1;
      drawStyledLine(buf, { x: inputInnerLeft, y: qy, width: inputInnerW, height: 1 }, qy, [
        span("? ", { fg: 222, bold: true, bg: inputBg }),
        span(aq.question.length > inputInnerW - 4 ? aq.question.slice(0, inputInnerW - 6) + "…" : aq.question,
          { fg: "white", bold: true, bg: inputBg }),
      ]);
      for (let i = 0; i < aq.options.length; i++) {
        const oy = qy + 1 + i;
        if (oy >= inputBoxY + INPUT_BOX_H - 1) break;
        const focused = aq.cursor === i;
        const picked = aq.selected.has(i);
        const marker = aq.multi ? (picked ? "◉" : "○") : (focused ? "❯" : " ");
        drawStyledLine(buf, { x: inputInnerLeft, y: oy, width: inputInnerW, height: 1 }, oy, [
          span(` ${marker} `, { fg: focused ? palette.accent : 245, bold: true, bg: inputBg }),
          span(aq.options[i]!, { fg: focused ? "white" : 252, bold: focused, bg: inputBg }),
        ]);
      }
      const hy = inputBoxY + INPUT_BOX_H - 1;
      drawStyledLine(buf, { x: inputInnerLeft, y: hy, width: inputInnerW, height: 1 }, hy, [
        span(aq.multi ? "↑↓ move · space toggle · enter confirm · esc skip"
                      : "↑↓ move · enter select · esc skip", { fg: palette.mutedFg - 3, bg: inputBg }),
      ]);
    } else if (permRequest) {
      // Input locked while permission card is shown above
      hideCursor();
      const fieldTop = inputBoxY + 1;
      drawStyledLine(buf, { x: inputInnerLeft, y: fieldTop, width: inputInnerW, height: 1 }, fieldTop, [
        span("› ", { fg: palette.border, bg: inputBg }),
        span("Waiting for approval…", { fg: 245, bg: inputBg, italic: true }),
      ]);
    } else if (isBusy) {
      // Shimmer along the card's top border instead of a floating bar
      const pulseR: Rect = {
        x: colL + 2,
        y: inputBoxY,
        width: boxRight - colL - 2,
        height: 1,
      };
      pulse.draw(buf, pulseR, { fg: palette.accent, bg: inputBg }, { fg: palette.border, bg: inputBg });

      // Rotating verb — a new one every 3s so long waits feel alive.
      const verbOf = (verbs: string[]) => verbs[Math.floor(elapsed / 3) % verbs.length]!;
      const stateLabel =
        replState === "thinking"  ? `${verbOf(THINKING_VERBS)}…` :
        replState === "streaming" ? `${verbOf(WRITING_VERBS)}…` :
        replState === "tool"      ? (subAgentLive.size > 0 ? "Delegating…" : "Running tools…") :
        "Working…";
      // Live detail: elapsed + rough streamed-token count when text is flowing.
      const streamedTok = streamBuffer.length > 0 ? Math.round(streamBuffer.length / 4) : 0;
      const details = [
        elapsed > 0 ? `${elapsed}s` : "",
        streamedTok > 0 ? `~${formatTok(streamedTok)} tok` : "",
      ].filter(Boolean).join(" · ");

      const statusLine: StyledLine = [
        span(`${spinner.frame} `, { fg: palette.accent, bg: inputBg }),
        span(stateLabel, { fg: palette.accent, bold: true, bg: inputBg }),
        ...(details ? [span(`  (${details})`, { fg: 245, bg: inputBg })] : []),
      ];
      drawStyledLine(buf, fieldInnerR, fieldInnerR.y, statusLine);
      hideCursor();
    } else {
      // Prompt glyph on the first inner row; input wraps across all inner rows.
      const fieldTop  = inputBoxY + 1;
      const fieldRows = INPUT_BOX_H - 2;
      drawStyledLine(buf, { x: inputInnerLeft, y: fieldTop, width: 2, height: 1 }, fieldTop, [
        span("› ", { fg: palette.accent, bold: true, bg: inputBg }),
      ]);
      const fieldR: Rect = {
        x: inputInnerLeft + 2,
        y: fieldTop,
        width: inputInnerW - 2,
        height: fieldRows,
      };
      lastFieldRect = fieldR;
      const tip = PLACEHOLDER_TIPS[Math.floor(Date.now() / 6000) % PLACEHOLDER_TIPS.length]!;
      field.render(buf, fieldR, { fg: "white", bg: inputBg }, {
        placeholder: " " + tip,
        placeholderStyle: { fg: 245, bg: inputBg, italic: true },
        singleLine: true,
      });
      process.stdout.write("\x1b]12;#ffffff\x07");
      showCursor();
    }

    // ── Agent / Model / Provider meta line — aligned with the transcript edge
    const metaY = inputBoxY + INPUT_BOX_H;
    const metaR: Rect = { x: colL + 2, y: metaY, width: inputInnerW + 1, height: 1 };

    const activeTier  = forceTier ?? lastTier;
    const tierColor   = TIER_COLOR_MAP[activeTier] ?? 228;
    const klaatModel  = activeCustomModel ?? (KLAATU_MODEL_MAP[activeTier] ?? `Klaatu ${activeTier}`);
    const dimFg = palette.sidebarLabel;
    const metaLine: StyledLine = [
      // Vim mode indicator — shown only when vim keybindings are enabled
      ...(vimMode ? [
        span(vimInsert ? "INSERT" : "NORMAL", { fg: vimInsert ? 82 : 226, bold: true }),
        span("  ·  ", { fg: dimFg }),
      ] : []),
      span("⏵ ", { fg: palette.accent }),
      span(tabs.activeTab.label, { fg: palette.chatFg as number | "white", bold: true }),
      span("  ·  ", { fg: dimFg }),
      span(klaatModel, { fg: tierColor, bold: true }),
      ...(forceTier ? [span(" 🔒", { fg: 228 })] : []),
      span("  ·  ", { fg: dimFg }),
      span("KlaatAI", { fg: dimFg }),
    ];
    drawStyledLine(buf, metaR, metaY, metaLine);

    // Right-aligned rotating tip on the meta line
    if (!isBusy) {
      const metaTip = META_TIPS[Math.floor(Date.now() / 8000) % META_TIPS.length]!;
      const tipW = stringWidth(metaTip);
      const tipX = metaR.x + metaR.width - tipW;
      const metaLeftW = metaLine.reduce((w, s) => w + stringWidth(s.text), 0);
      if (tipX > metaR.x + metaLeftW + 2) {
        drawStyledLine(buf, { x: tipX, y: metaY, width: tipW, height: 1 }, metaY, [
          span(metaTip, { fg: 243, italic: true }),
        ]);
      }
    }

    // ── Footer bar
    const footerY = metaY + 1 + GAP_H;
    const footerR: Rect = { x: inputInnerLeft, y: footerY, width: inputInnerW, height: 1 };
    const totalTokInput = lastContextSize;
    const ctxPctFoot = getContextWindow() > 0
      ? Math.round((lastContextSize / getContextWindow()) * 100)
      : 0;

    if (isBusy) {
      const footerLeft: StyledLine = [
        span(spinner.frame, { fg: palette.accent }),
        span(" esc", { fg: "white", bold: true }),
        span(" interrupt", { fg: "gray" }),
      ];
      drawStyledLine(buf, footerR, footerY, footerLeft);
    }

    // (context %/tokens and ctrl+p hint live in the bottom status bar — see below)
    void totalTokInput; void ctxPctFoot;

    // ═══════════════════════════════════════════════════════════════════
    // SIDEBAR
    // ═══════════════════════════════════════════════════════════════════

    if (showSidebar && sidebarR.width > 0) {
      const sInner: Rect = {
        x: colS + 2,
        y: sidebarR.y + 1,
        width: colR - colS - 3,
        height: sidebarR.height - 1,
      };
      let sRow = sInner.y;

      const totalTok = totalTokens.prompt + totalTokens.completion;

      // ── Sidebar layout helpers (flush-right value column) ───────────────
      const swOf = (l: StyledLine) => l.reduce((w, s) => w + stringWidth(s.text), 0);
      /** Label on the left, value spans flush-right against the panel edge. */
      const sbKV = (label: string, value: StyledLine): void => {
        if (sRow >= sInner.y + sInner.height) return;
        const gap = Math.max(1, sInner.width - 2 - stringWidth(label) - swOf(value));
        drawStyledLine(buf, sInner, sRow, [
          span("  " + label, { fg: palette.sidebarLabel }),
          span(" ".repeat(gap), {}),
          ...value,
        ]);
        sRow++;
      };
      const sbHeader = (title: string, trailing?: StyledLine): void => {
        if (sRow >= sInner.y + sInner.height) return;
        drawStyledLine(buf, sInner, sRow, [
          span(title, { fg: palette.accent, bold: true }),
          ...(trailing ?? []),
        ]);
        sRow++;
        if (sRow >= sInner.y + sInner.height) return;
        drawStyledLine(buf, sInner, sRow, [
          span("─".repeat(sInner.width), { fg: 237 }),
        ]);
        sRow++;
      };
      const sbBlank = () => { sRow++; };

      // ── Model / Routing lock indicator ──────────────────────────────
      const sActiveTier  = forceTier ?? lastTier;
      const sTierColor   = (TIER_COLOR_MAP as Record<string, number | string>)[sActiveTier] ?? 228;
      const sModelName   = activeCustomModel ?? (KLAATU_MODEL_MAP[sActiveTier] ?? `Klaatu ${sActiveTier}`);
      drawStyledLine(buf, sInner, sRow, [
        span(forceTier ? "⊘ Locked  " : "⟳ Routing ", { fg: forceTier ? 222 : palette.sidebarLabel }),
        span(sModelName, { fg: sTierColor as number, bold: true }),
        ...(forceTier ? [span("  🔒", { fg: 222 })] : []),
      ]);
      sRow += 2;

      const tokVal = (n: number, unit = "toks", bold = false) => [
        span(formatTok(n), bold ? { fg: palette.chatFg as number | "white", bold: true } : { fg: palette.sidebarValue }),
        span(" " + unit, { fg: palette.mutedFg }),
      ];

      // ── Session Usage section ────────────────────────────────────────
      sbHeader("Session");
      sbKV("Requests", [span(String(totalRequests), { fg: palette.chatFg as number | "white", bold: true })]);
      sbKV("Input",  tokVal(totalTokens.prompt));
      sbKV("Output", tokVal(totalTokens.completion));
      sbKV("Total",  tokVal(totalTok, "toks", true));
      sbKV("Cost",   [span(`$${sessionCost.toFixed(4)}`, { fg: 114, bold: true })]);
      sbBlank();

      // ── Lifetime Usage section ───────────────────────────────────────
      sbHeader("Lifetime");
      if (!lifetimeStats) {
        drawStyledLine(buf, sInner, sRow, [span("  Fetching…", { fg: palette.mutedFg, dim: true })]);
        sRow++;
      } else {
        sbKV("Requests", [span(String(lifetimeStats.total_requests), { fg: palette.chatFg as number | "white", bold: true })]);
        sbKV("Input",  tokVal(lifetimeStats.prompt_tokens, "tok"));
        sbKV("Output", tokVal(lifetimeStats.completion_tokens, "tok"));
        sbKV("Total",  tokVal(lifetimeStats.total_tokens, "tok", true));
        sbKV("Cost",   [span(`$${lifetimeStats.total_cost_usd.toFixed(2)}`, { fg: 114, bold: true })]);
        const topTier = Object.entries(lifetimeStats.by_tier)
          .sort((a, b) => b[1].total_tokens - a[1].total_tokens)[0];
        if (topTier) {
          const [tierName, tierData] = topTier;
          const tc = (TIER_COLOR_MAP as Record<string, number | string>)[tierName] ?? 252;
          sbKV("Top tier", [
            span(tierName, { fg: tc as number, bold: true }),
            span(` ${tierData.requests}×`, { fg: palette.mutedFg }),
          ]);
        }
      }
      sbBlank();

      // ── Context section ─────────────────────────────────────────────
      sbHeader("Context");
      const ctxTotalWindow = Object.values(TIER_CONTEXT_WINDOW).reduce((a, b) => a + b, 0);
      const ctxWindow = getContextWindow();
      const ctxUsed = lastContextSize;
      const ctxPct = ctxWindow > 0
        ? Math.min(100, Math.round((ctxUsed / ctxWindow) * 100))
        : 0;
      const ctxRemaining = Math.max(0, ctxWindow - ctxUsed);
      const ctxColor = ctxPct > 80 ? 204 : ctxPct > 50 ? 222 : 75;

      sbKV("Max Window", tokVal(ctxTotalWindow));
      sbKV("Current",    tokVal(ctxWindow));
      sbKV("Used", [
        span(formatTok(ctxUsed), { fg: ctxColor, bold: true }),
        span(` ${ctxPct}%`, { fg: ctxColor }),
      ]);
      // Progress bar
      const barW = sInner.width - 4;
      if (barW > 4) {
        const filled = Math.round((ctxPct / 100) * barW);
        drawStyledLine(buf, sInner, sRow, [
          span("  ", {}),
          span("█".repeat(filled), { fg: ctxColor }),
          span("─".repeat(barW - filled), { fg: 238 }),
        ]);
        sRow++;
      }
      sbKV("Remaining", tokVal(ctxRemaining));
      sbBlank();

      // ── MCP Servers section ──────────────────────────────────────────
      const mcpServers = mcpManager.servers;
      sbHeader("MCP Servers", [span(`  ${mcpServers.length}`, { fg: mcpServers.length > 0 ? 114 : 243 })]);
      if (mcpServers.length === 0) {
        drawStyledLine(buf, sInner, sRow, [
          span("  (none configured)", { fg: 243, dim: true }),
        ]);
        sRow++;
      } else {
        for (const srv of mcpServers) {
          if (sRow >= sInner.y + sInner.height) break;
          const icon   = srv.status === "connected" ? "●" : srv.status === "error" ? "✗" : "○";
          const iconFg: number = srv.status === "connected" ? 114 : srv.status === "error" ? 204 : 245;
          const toolCount = srv.status === "connected" ? ` ${srv.tools.length}t` : "";
          const nameW = sInner.width - 4 - stringWidth(toolCount);
          const displayName = srv.name.length > nameW
            ? srv.name.slice(0, nameW - 1) + "…"
            : srv.name;
          drawStyledLine(buf, sInner, sRow, [
            span("  ", {}),
            span(icon, { fg: iconFg }),
            span(" ", {}),
            span(displayName, { fg: srv.status === "connected" ? ("white" as const) : 245 }),
            ...(toolCount ? [span(toolCount, { fg: 243 })] : []),
          ]);
          sRow++;
          // Show truncated error message below errored servers
          if (srv.status === "error" && srv.statusMessage && sRow < sInner.y + sInner.height) {
            const errW = sInner.width - 4;
            const errMsg = srv.statusMessage.length > errW
              ? srv.statusMessage.slice(0, errW - 1) + "…"
              : srv.statusMessage;
            drawStyledLine(buf, sInner, sRow, [
              span("    " + errMsg, { fg: 204, dim: true }),
            ]);
            sRow++;
          }
        }
      }
      sRow++;

      // ── Code Graph section ───────────────────────────────────────────
      if (graphStats) {
        const g = graphStats;
        sbHeader("Code Graph", g.indexing
          ? [span("  ⟳ indexing", { fg: 222 })]
          : [span("  ●", { fg: 114 }), span(" ready", { fg: palette.mutedFg })]);
        if (g.indexing && g.total > 0) {
          sbKV("Progress", [span(`${g.indexed}/${g.total}`, { fg: 222 }), span(" files", { fg: palette.mutedFg })]);
        }
        sbKV("Files",   [span(formatTok(g.files), { fg: palette.sidebarValue })]);
        sbKV("Symbols", [span(formatTok(g.symbols), { fg: palette.sidebarValue })]);
        sbKV("Edges",   [span(formatTok(g.edges), { fg: g.edges > 0 ? palette.sidebarValue : 243 })]);
        sbKV("Embedded", g.embedded > 0
          ? [span(formatTok(g.embedded), { fg: 114 }), span(g.symbols > 0 ? ` ${Math.round(g.embedded / g.symbols * 100)}%` : "", { fg: palette.mutedFg })]
          : [span("—", { fg: 243 })]);
        sbBlank();
      }

      // ── Routing Analytics section (mini bar chart) ───────────────────
      sbHeader("Model Tier Routing");
      if (tierCounts.size === 0) {
        drawStyledLine(buf, sInner, sRow, [span("  (no requests yet)", { fg: palette.mutedFg, dim: true })]);
        sRow++;
      } else {
        const sortedTiers = [...tierCounts.entries()].sort((a, b) => b[1] - a[1]);
        const maxCount = Math.max(...sortedTiers.map(([, c]) => c));
        const chartW = Math.max(6, sInner.width - 18); // leave room for label + pct
        for (const [tier, count] of sortedTiers) {
          if (sRow >= sInner.y + sInner.height) break;
          const tierColor = (TIER_COLOR_MAP as Record<string, number | string>)[tier] ?? 252;
          const pct = totalRequests > 0 ? Math.round((count / totalRequests) * 100) : 0;
          const filled = Math.max(1, Math.round((count / maxCount) * chartW));
          drawStyledLine(buf, sInner, sRow, [
            span("  ", {}),
            span(tier.padEnd(7).slice(0, 7), { fg: tierColor }),
            span("▇".repeat(filled), { fg: tierColor }),
            span("─".repeat(Math.max(0, chartW - filled)), { fg: 237 }),
            span(` ${String(pct).padStart(2)}%`, { fg: palette.mutedFg }),
          ]);
          sRow++;
        }
        // Estimated savings vs always-heavy
        const HEAVY = TIER_COSTS["heavy"] ?? [2.50, 8.00];
        let savings = 0;
        const avgPrompt = totalTokens.prompt   / Math.max(1, totalRequests);
        const avgCompl  = totalTokens.completion / Math.max(1, totalRequests);
        for (const [tier, count] of tierCounts.entries()) {
          const [inp, out] = TIER_COSTS[tier] ?? [0.5, 1.5];
          savings += count * (avgPrompt * (HEAVY[0] - inp) + avgCompl * (HEAVY[1] - out)) / 1_000_000;
        }
        if (savings > 0.0001) {
          sbKV("Saved vs heavy", [span(`$${savings.toFixed(4)}`, { fg: 114, bold: true })]);
        }
      }
      sbBlank();

      // ── Modified Files section (expandable) ─────────────────────────
      const fileCount = modifiedFiles.length;
      drawStyledLine(buf, sInner, sRow, [
        span(filesExpanded ? "▼ " : "▶ ", { fg: palette.accent }),
        span("Modified Files", { fg: palette.accent, bold: true }),
        span(`  ${fileCount}`, { fg: fileCount > 0 ? 222 : 243 }),
      ]);
      hitGrid.addRow("toggle:files", sRow, sInner.x, sInner.width, 0, "");
      sRow++;

      if (filesExpanded) {
        if (fileCount === 0) {
          drawStyledLine(buf, sInner, sRow, [
            span("  (none)", { fg: 243, dim: true }),
          ]);
          sRow++;
        } else {
          for (const f of modifiedFiles) {
            if (sRow >= sInner.y + sInner.height) break;
            const addStr = `+${f.additions}`;
            const delStr = `-${f.deletions}`;
            const nameW = sInner.width - stringWidth(addStr) - stringWidth(delStr) - 4;
            const displayPath = f.path.length > nameW
              ? "…" + f.path.slice(f.path.length - nameW + 1)
              : f.path;

            const line: StyledLine = [
              span("  ", {}),
              clickable(displayPath, `file:${f.path}`, "cyan"),
              span(" ".repeat(Math.max(1, nameW - stringWidth(displayPath) + 1))),
              span(addStr, { fg: 114 }),
              span(" ", {}),
              span(delStr, { fg: 204 }),
            ];
            const hits = drawStyledLine(buf, sInner, sRow, line);
            for (const [id, hit] of hits) {
              hitGrid.addRow(id, sRow, hit.col, hit.width, 0, f.path);
            }
            sRow++;
          }
        }
      }

      // ── Branding — pinned to sidebar bottom (path lives in the status bar) ──
      const brandRow = sInner.y + sInner.height - 1;
      if (brandRow > sRow) {
        drawStyledLine(buf, sInner, brandRow, [
          span("● ", { fg: 114, bold: true }),
          span("Klaat Code", { fg: "white", bold: true }),
          span(`  v${APP_VERSION}`, { fg: palette.mutedFg, dim: true }),
        ]);
      }
    }

    // ═══════════════════════════════════════════════════════════════════
    // STATUS BAR
    // ═══════════════════════════════════════════════════════════════════

    const totalTok = totalTokens.prompt + totalTokens.completion;
    const ctxPctStatus = getContextWindow() > 0
      ? Math.round((lastContextSize / getContextWindow()) * 100) : 0;
    const sidebarToggleLabel = showSidebar ? "Hide Sidebar" : "Show Sidebar";

    // Build right-side status content
    const bgRunning = [...bgTasks.values()].filter(t => t.status === "running").length;
    const rightLine: StyledLine = [
      ...(bgRunning > 0
        ? [span(`◔ ${bgRunning} bg agent${bgRunning > 1 ? "s" : ""}`, { fg: 214, bold: true }), span("   ", {})]
        : []),
      span(sidebarToggleLabel, { fg: 75, bold: true }),
      span(" (Ctrl+B)", { fg: 245 }),
      span("   ", {}),
      bold(formatTok(lastContextSize), "white"),
      ...(lastContextSize > 0 ? [span(` (${ctxPctStatus}%)`, { fg: ctxPctStatus > 80 ? 204 : 245 })] : []),
      span("   ", {}),
      span("ctrl+p", { fg: "white", bold: true }),
      span(" commands ", { fg: 245 }),
    ];
    const rw = rightLine.reduce((w, s) => w + stringWidth(s.text), 0);
    const rightEdge = showSidebar ? colS - 1 : area.width - 1;
    const rightX = Math.max(0, rightEdge - rw);
    const rightR: Rect = { x: rightX, y: statusArea.y, width: rw, height: 1 };
    drawStyledLine(buf, rightR, statusArea.y, rightLine);

    // Register clickable hit region for sidebar toggle button
    const toggleW = stringWidth(sidebarToggleLabel + " (Ctrl+B)");
    hitGrid.addRow("toggle:sidebar", statusArea.y, rightR.x, toggleW, 1, "");

    // Left path + breadcrumb — truncated to fit before the right-side content
    const cwd = projectRoot;
    const shortPath = cwd.replace(process.env.HOME ?? "", "~");
    const maxPathW = Math.max(0, rightX - 2);

    // Clear stale breadcrumb after 15s of idle
    const breadcrumb = (lastActiveFile && Date.now() - lastActiveFileTime < 15_000) ? lastActiveFile : "";

    if (maxPathW > 5) {
      if (breadcrumb && isBusy) {
        // When busy, show breadcrumb instead of project path
        const bcDisplay = breadcrumb.length > maxPathW - 4
          ? "…" + breadcrumb.slice(-(maxPathW - 5))
          : breadcrumb;
        drawStyledLine(buf, { x: 0, y: statusArea.y, width: maxPathW, height: 1 }, statusArea.y, [
          span(" "),
          span("◆ ", { fg: palette.accent }),
          span(bcDisplay, { fg: 252 }),
        ]);
      } else {
        const displayPath = stringWidth(shortPath) > maxPathW
          ? "…" + shortPath.slice(-(maxPathW - 1))
          : shortPath;
        drawStyledLine(buf, { x: 0, y: statusArea.y, width: maxPathW, height: 1 }, statusArea.y, [
          span(" "),
          dim(displayPath),
        ]);
      }
    }

    // ═══════════════════════════════════════════════════════════════════
    // FRAME — drawn LAST
    // ═══════════════════════════════════════════════════════════════════

    // Top edge — borderless (content breathes to the top)
    // if (showSidebar) buf.write(contentArea.y, colS, "▏", { fg: 237 });

    // Vertical rails — outer frame hidden (black), sidebar divider hidden
    for (let r = contentArea.y + 1; r < contentArea.y + contentArea.height; r++) {
      buf.write(r, colL, "┃", { fg: "black" });
      buf.write(r, colR, "┃", { fg: "black" });
      // if (showSidebar) buf.write(r, colS, "▏", { fg: 237 });
    }
    // Clickable hit region on the sidebar divider column
    if (showSidebar) {
      hitGrid.addRow("toggle:sidebar", contentArea.y, colS, 1, contentArea.height, "");
    }

    // Accent left edge for the input card (between the rounded corners)
    for (let r = boxR.inputBoxY + 1; r <= boxR.bottomY - 1; r++) {
      buf.write(r, colL + 1, "│", { fg: 219, bg: inputBg });
    }

    // Bottom edge — borderless; the status bar (path · ctrl+p) IS the last row.
    // if (showSidebar) buf.write(statusArea.y, colS, "▏", { fg: 237 });

    // Dialog overlay
    dialog.render(buf, area);
  }

  // ─── Cleanup / quit ────────────────────────────────────────────────────────

  const unsubscribers: Array<() => void> = [];
  let _quitting = false;
  let _resolveQuit: (() => void) | null = null;

  function quit(): void {
    if (_quitting) return;
    _quitting = true;
    clearInterval(tipTimer);
    for (const u of unsubscribers) u();
    mcpManager.disconnectAll();
    killAllBackground();
    spinner.stop();
    pulse.stop();
    stopTimer();
    if (_resolveQuit) _resolveQuit();
  }

  // ─── Register key handlers ─────────────────────────────────────────────────

  unsubscribers.push(app.onKey("ctrl+c", () => quit()));
  unsubscribers.push(app.onKey("ctrl+b", () => {
    const current = sidebarOverride !== null ? sidebarOverride : true;
    sidebarOverride = !current;
    chatLinesDirty = true;
    app.requestRender();
  }));
  unsubscribers.push(app.onKey("ctrl+y", () => {
    // Copy last assistant response to clipboard
    const lastAssistant = [...messages].reverse().find(m => m.role === "assistant" && m.kind !== "error");
    if (!lastAssistant) { pushSystemMsg("Nothing to copy yet."); return; }
    const ok = copyToClipboard(lastAssistant.content);
    pushSystemMsg(ok ? "Copied last response to clipboard." : "Clipboard copy failed (install pbcopy/xclip/xsel).");
    chatLinesDirty = true;
    app.requestRender();
  }));
  unsubscribers.push(app.onKey("ctrl+v", () => {
    // Attach a raw image from the OS clipboard (screenshots have no file
    // path, so they never arrive through the terminal's text paste).
    if (dialog.active) return;
    const res = readClipboardImage();
    if (!res.ok) {
      if (res.reason === "too_large") {
        const mb = (res.sizeBytes / (1024 * 1024)).toFixed(1);
        const cap = (MAX_IMAGE_BYTES / (1024 * 1024)).toFixed();
        pushSystemMsg(
          `Clipboard image is ${mb}MB, over the ${cap}MB limit — try a smaller crop or window screenshot.`
        );
      } else {
        pushSystemMsg("No image on the clipboard. (Text pastes with cmd/ctrl+shift+v as usual.)");
      }
      chatLinesDirty = true;
      app.requestRender();
      return;
    }
    const img = res.image;
    const n = pendingImages.length + 1;
    pendingImages.push({ path: `clipboard-${n}.png`, b64: img.b64, mime: img.mime });
    field.paste(`[Image: clipboard #${n}] `);
    chatLinesDirty = true;
    app.requestRender();
  }));
  unsubscribers.push(app.onKey("ctrl+d", () => {
    // In vim NORMAL mode, ctrl+d scrolls chat down (half-page)
    if (vimMode && !vimInsert) {
      chatSV.scroll(10, cachedChatLines.length, 10);
      const maxTop = Math.max(0, cachedChatLines.length - 10);
      if (chatSV.scrollTop >= maxTop) chatAutoScroll = true;
      app.requestRender();
      return;
    }
    quit();
  }));

  unsubscribers.push(app.onKey("escape", () => {
    if (dialog.active) { dialog.dismiss(); return; }
    if (slashSuggest) { slashSuggest = null; app.requestRender(); return; }
    if (themePicker) { themePicker = null; app.requestRender(); return; }
    if (askRequest) { const aq = askRequest; askRequest = null; aq.resolve("(user skipped — decide with your best judgment)"); app.requestRender(); return; }
    // Vim mode: ESC in INSERT → switch to NORMAL; in NORMAL → cancel stream
    if (vimMode && vimInsert) {
      vimInsert   = false;
      vimPendingD = false;
      vimPendingG = false;
      chatLinesDirty = true;
      app.requestRender();
      return;
    }
    if (replState !== "idle" && replState !== "permission") {
      interrupted  = true;
      replState    = "idle";
      streamBuffer = "";
      chatLinesDirty = true;
      stopTimer();
      app.requestRender();
    }
  }));

  unsubscribers.push(app.onKey("tab", () => {
    if (dialog.active) return;
    if (permRequest) { permSelected = (permSelected + 1) % 4; app.requestRender(); return; }
    if (slashSuggest) {
      // Tab completes the highlighted command into the input (with trailing space).
      field.value = slashSuggest.items[slashSuggest.selected]!.cmd + " ";
      field.cursorToEnd();
      slashSuggest = null;
      app.requestRender();
      return;
    }
    tabs.next();
    app.requestRender();
  }));

  unsubscribers.push(app.onKey("shift+tab", () => {
    if (dialog.active) return;
    tabs.prev();
    app.requestRender();
  }));

  unsubscribers.push(app.onKey("ctrl+r", () => {
    // Reverse history search — fuzzy picker over past inputs (newest first).
    if (dialog.active || replState !== "idle") return;
    if (history.length === 0) { pushSystemMsg("No input history yet."); return; }
    const seen = new Set<string>();
    const items = [...history].reverse()
      .filter(h => { if (seen.has(h)) return false; seen.add(h); return true; })
      .map(h => ({ label: h.length > 80 ? h.slice(0, 77) + "…" : h, value: h, description: "" }));
    dialog.showList("Search history (type to filter)", items, (item) => {
      field.value = item.value;
      field.cursorToEnd();
      app.requestRender();
    });
    app.requestRender();
  }));

  unsubscribers.push(app.onKey("ctrl+p", () => {
    if (dialog.active) { dialog.dismiss(); return; }
    dialog.showList("Command Palette", [
      { label: "New Session",     value: "new",        description: "Start a fresh session (saves current)", color: "cyan" },
      { label: "Clear Chat",      value: "clear",      description: "Clear messages but keep session",       color: "yellow" },
      { label: "Switch Tier",     value: "tier",       description: "Lock or unlock a Klaatu routing tier", color: "#d8b4fe" },
      { label: "Switch Model",    value: "model",      description: "Klaatu or a custom third-party model", color: "#d8b4fe" },
      { label: "Toggle Sidebar",  value: "sidebar",    description: "Show/hide the context sidebar",        color: "green" },
      { label: "Sessions",        value: "sessions",   description: "List saved sessions",                  color: "cyan" },
      { label: "Compact Context", value: "compact",    description: "Summarise to free context window",     color: "yellow" },
      { label: "Checkpoint",      value: "checkpoint", description: "Snapshot modified files for rollback", color: "#fb923c" },
      { label: "Export",          value: "export",     description: "Export session to Markdown file",     color: "#f9a8d4" },
      { label: "Git Diff",        value: "diff",       description: "Show git diff for all changes",        color: "#60a5fa" },
      { label: "Insert @ File",   value: "at",         description: "Pick a file to inject into message",  color: "#34d399" },
      { label: "Open in Editor",  value: "editor",     description: "Compose in $EDITOR (ctrl+x ctrl+e)",  color: "white" },
      { label: "Vim Mode",        value: "vimmode",    description: `${vimMode ? "Disable" : "Enable"} vim key bindings (i/Esc to toggle INSERT/NORMAL)`, color: "#a78bfa" },
      { label: "Run Tests",       value: "test",       description: "Run test suite (auto-detects Bun/Vitest/Jest/pytest/Go/Cargo)",      color: "#4ade80" },
      { label: "Code Review",     value: "review",     description: "AI code review of current git diff",                                  color: "#f59e0b" },
      { label: "AI Commit",       value: "commit",     description: "Generate a git commit message with AI and commit",                    color: "#a78bfa" },
      { label: "Skills",          value: "skills",     description: "List and invoke saved prompt skills",                                 color: "#67e8f9" },
      { label: "Hooks",           value: "hooks",      description: "List configured lifecycle hooks",                                     color: "#f472b6" },
      { label: "Exit",            value: "exit",       description: "Quit KLAAT CODE",                                                     color: "red" },
    ], (item) => {
      if (item.value === "exit") {
        quit();
      } else if (item.value === "clear") {
        messages.length = 0; // empty → welcome banner shows again
        apiMessages = seedSystemMessages(projectRoot, ledger.path);
        modifiedFiles.length = 0;
        totalTokens = { prompt: 0, completion: 0 };
        lastContextSize = 0;
        sessionCost = 0;
        chatLinesDirty = true;
        chatAutoScroll = true;
        app.requestRender();
      } else if (item.value === "new") {
        // New session — reset everything
        messages.length = 0;
        messages.push({ role: "system", content: "New session started. How can I help?" });
        apiMessages      = [];
        lastMeta         = null;
        streamBuffer     = "";
        modifiedFiles.length = 0;
        totalTokens      = { prompt: 0, completion: 0 };
        lastContextSize  = 0;
        sessionCost      = 0;
        totalRequests    = 0;
        tierCounts.clear();
        history          = [];
        forceTier        = null;
        sessionApproved.clear();
        chatLinesDirty   = true;
        chatAutoScroll   = true;
        app.requestRender();
      } else if (item.value === "tier") {
        openTierPicker();
      } else if (item.value === "model") {
        openModelPicker();
      } else if (item.value === "sidebar") {
        // Toggle sidebar override
        const current = sidebarOverride !== null ? sidebarOverride : true;
        sidebarOverride = !current;
        app.requestRender();
      } else if (item.value === "sessions") {
        handleSlashCommand("/sessions");
      } else if (item.value === "compact") {
        if (apiMessages.length < 6) {
          pushSystemMsg("Context is short — no compact needed.");
        } else {
          pushSystemMsg("Compacting context…");
          void compactContext();
        }
      } else if (item.value === "checkpoint") {
        handleSlashCommand("/checkpoint");
      } else if (item.value === "export") {
        handleSlashCommand("/export");
      } else if (item.value === "diff") {
        handleSlashCommand("/diff");
      } else if (item.value === "at") {
        openFilePicker();
      } else if (item.value === "editor") {
        void openExternalEditor();
      } else if (item.value === "vimmode") {
        handleSlashCommand("/vimmode");
      } else if (item.value === "test") {
        handleSlashCommand("/test");
      } else if (item.value === "review") {
        handleSlashCommand("/review");
      } else if (item.value === "commit") {
        handleSlashCommand("/commit");
      } else if (item.value === "skills") {
        handleSlashCommand("/skill list");
      } else if (item.value === "hooks") {
        handleSlashCommand("/hooks");
      }
    });
  }));

  // Input submission
  field.onSubmit = (text) => {
    if (!text.trim() || busy()) return;
    field.clear();
    void sendMessage(text);   // paste chips expanded for the model inside sendMessage
  };

  unsubscribers.push(app.onKey("enter", (ev) => {
    if (dialog.active) { dialog.handleKey(ev); return; }
    if (themePicker) {
      const selected = THEME_NAMES[themePicker.cursor];
      themePicker = null;
      if (selected && selected !== activeTheme) {
        activeTheme    = selected;
        palette        = getPalette(selected);
        chatLinesDirty = true;
        saveConfig({ theme: selected });
        pushSystemMsg(`Theme switched to **${selected}**. ${THEME_DESCRIPTIONS[selected]}`);
      }
      app.requestRender();
      return;
    }
    if (askRequest) {
      const aq = askRequest;
      askRequest = null;
      const answer = aq.multi
        ? (aq.selected.size > 0 ? [...aq.selected].sort().map(i => aq.options[i]!).join(", ") : aq.options[aq.cursor]!)
        : aq.options[aq.cursor]!;
      aq.resolve(answer);
      app.requestRender();
      return;
    }
    if (permRequest) {
      const pr = permRequest;
      const DECISIONS: PermDecision[] = ["allow_once", "deny", "allow_session", "allow_always"];
      permRequest = null;
      pr.resolve(DECISIONS[permSelected]!);
      app.requestRender();
      return;
    }
    if (slashSuggest) {
      // Enter runs the highlighted suggestion (completes partial input first).
      const pick = slashSuggest.items[slashSuggest.selected]!.cmd;
      if (field.value !== pick) { field.value = pick; field.cursorToEnd(); }
      slashSuggest = null;
    }
    if (field.handleKey(ev, { singleLine: true })) app.requestRender();
    updateSlashSuggest();
  }));

  unsubscribers.push(app.onKey("up", (ev) => {
    if (dialog.active) { dialog.handleKey(ev); return; }
    if (themePicker) { themePicker.cursor = (themePicker.cursor - 1 + THEME_NAMES.length) % THEME_NAMES.length; app.requestRender(); return; }
    if (askRequest) { askRequest.cursor = (askRequest.cursor - 1 + askRequest.options.length) % askRequest.options.length; app.requestRender(); return; }
    if (slashSuggest) {
      const n = slashSuggest.items.length;
      slashSuggest.selected = (slashSuggest.selected - 1 + n) % n;
      app.requestRender();
      return;
    }
    if (replState === "idle" && !permRequest) {
      // Up → previous history entry (older)
      field.historyPrev(history);
      app.requestRender();
      updateSlashSuggest();
    }
  }));

  unsubscribers.push(app.onKey("down", (ev) => {
    if (dialog.active) { dialog.handleKey(ev); return; }
    if (themePicker) { themePicker.cursor = (themePicker.cursor + 1) % THEME_NAMES.length; app.requestRender(); return; }
    if (askRequest) { askRequest.cursor = (askRequest.cursor + 1) % askRequest.options.length; app.requestRender(); return; }
    if (slashSuggest) {
      slashSuggest.selected = (slashSuggest.selected + 1) % slashSuggest.items.length;
      app.requestRender();
      return;
    }
    if (replState === "idle" && !permRequest) {
      // Down → next history entry (newer) / restore draft
      field.historyNext(history);
      app.requestRender();
      updateSlashSuggest();
    }
  }));

  // Page Up / Page Down → scroll chat
  unsubscribers.push(app.onKey("page_up", (ev) => {
    if (dialog.active) { dialog.handleKey(ev); return; }
    chatAutoScroll = false;
    chatSV.scroll(-10, cachedChatLines.length, 10);
    app.requestRender();
  }));

  unsubscribers.push(app.onKey("page_down", (ev) => {
    if (dialog.active) { dialog.handleKey(ev); return; }
    chatSV.scroll(10, cachedChatLines.length, 10);
    const maxTop = Math.max(0, cachedChatLines.length - 10);
    if (chatSV.scrollTop >= maxTop) chatAutoScroll = true;
    app.requestRender();
  }));

  unsubscribers.push(app.onKey("*", (ev) => {
    // Theme picker: swallow all keys (only up/down/enter/esc handled above)
    if (themePicker) return;
    // ask_user picker: space toggles (multi), number keys jump to option
    if (askRequest) {
      const aq = askRequest;
      if (ev.char === " " && aq.multi) {
        aq.selected.has(aq.cursor) ? aq.selected.delete(aq.cursor) : aq.selected.add(aq.cursor);
        app.requestRender();
        return;
      }
      const n = ev.char ? parseInt(ev.char, 10) : NaN;
      if (!Number.isNaN(n) && n >= 1 && n <= aq.options.length) {
        aq.cursor = n - 1;
        if (!aq.multi) { askRequest = null; aq.resolve(aq.options[n - 1]!); }
        app.requestRender();
        return;
      }
      return; // swallow other keys while the picker is open
    }
    // Permission prompt
    if (permRequest) {
      const pr = permRequest;
      const ch = ev.char?.toLowerCase();
      const decide = (d: PermDecision) => { permRequest = null; pr.resolve(d); app.requestRender(); };
      if (ch === "y") return decide("allow_once");
      if (ch === "s") return decide("allow_session");
      if (ch === "a") return decide("allow_always");
      if (ch === "n" || ev.key === "escape") return decide("deny");
      // Arrows reach the catch-all (no specific handler); enter/tab are caught
      // by their own handlers above since specific handlers pre-empt "*".
      if (ev.key === "left")  { permSelected = (permSelected + 3) % 4; app.requestRender(); return; }
      if (ev.key === "right") { permSelected = (permSelected + 1) % 4; app.requestRender(); return; }
      return;
    }

    if (dialog.active) { dialog.handleKey(ev); return; }

    // ── ctrl+x leader key (ctrl+x ctrl+e = external editor) ────────────
    if (ev.key === "ctrl+x") {
      ctrlXPressed = true;
      return; // consume, wait for next key
    }
    if (ctrlXPressed) {
      ctrlXPressed = false;
      if (ev.key === "ctrl+e" && replState === "idle" && !permRequest) {
        void openExternalEditor();
        return;
      }
      // Not ctrl+e — fall through to handle the key normally
    }

    // ── Vim NORMAL mode ──────────────────────────────────────────────────
    if (vimMode && !vimInsert) {
      const ch  = ev.char ?? "";
      const key = ev.key;
      /** Construct a synthetic KeyEvent for field.handleKey calls. */
      const mk = (k: string, extras: Partial<KeyEvent> = {}): KeyEvent => ({
        key: k, ctrl: false, alt: false, shift: false, raw: Buffer.alloc(0), ...extras,
      });

      // ── Pending compound: gg ───────────────────────────────────────────
      if (vimPendingG) {
        vimPendingG = false;
        if (ch === "g") {
          chatSV.scrollToTop();
          chatAutoScroll = false;
          app.requestRender();
        }
        return;
      }

      // ── Pending compound: dd / dw / d$ ────────────────────────────────
      if (vimPendingD) {
        vimPendingD = false;
    if (replState === "idle") {
          if (ch === "d") {
            const before = field.value;
            field.handleKey(mk("ctrl+u", { ctrl: true }), { singleLine: true }); // dd: clear input
            yankDeleted(before);
          } else if (ch === "w") {
            const before = field.value;
            field.handleKey(mk("ctrl+w", { ctrl: true }), { singleLine: true }); // dw
            yankDeleted(before);
          } else if (ch === "$") {
            const before = field.value;
            field.handleKey(mk("ctrl+k", { ctrl: true }), { singleLine: true }); // d$
            yankDeleted(before);
          }
        }
        app.requestRender();
        return;
      }

      // ── Chat navigation (works in any REPL state) ─────────────────────
      if (ch === "j") {
        chatSV.scroll(3, cachedChatLines.length, 10);
        if (chatSV.scrollTop >= Math.max(0, cachedChatLines.length - 10)) chatAutoScroll = true;
        app.requestRender(); return;
      }
      if (ch === "k") {
        chatAutoScroll = false;
        chatSV.scroll(-3, cachedChatLines.length, 10);
        app.requestRender(); return;
      }
      if (ch === "G") {
        chatSV.scrollToBottom(cachedChatLines.length, 10);
        chatAutoScroll = true; app.requestRender(); return;
      }
      if (ch === "g") { vimPendingG = true; return; }
      // ctrl+u in NORMAL mode: scroll chat up (half-page)
      if (key === "ctrl+u") {
        chatAutoScroll = false;
        chatSV.scroll(-10, cachedChatLines.length, 10);
        app.requestRender(); return;
      }

      // ── Field editing motions (idle only) ─────────────────────────────
      if (replState === "idle") {
        switch (ch) {
          case "h": field.handleKey(mk("left"),       { singleLine: true }); app.requestRender(); return;
          case "l": field.handleKey(mk("right"),      { singleLine: true }); app.requestRender(); return;
          case "w":
          case "e": field.handleKey(mk("alt+right", { alt: true }), { singleLine: true }); app.requestRender(); return;
          case "b": field.handleKey(mk("alt+left",  { alt: true }), { singleLine: true }); app.requestRender(); return;
          case "0": field.handleKey(mk("home"),       { singleLine: true }); app.requestRender(); return;
          case "$": field.handleKey(mk("end"),        { singleLine: true }); app.requestRender(); return;
          case "x": {
            const before = field.value;
            field.handleKey(mk("delete"), { singleLine: true });
            yankDeleted(before);
            app.requestRender(); return;
          }
          case "D": {
            const before = field.value;
            field.handleKey(mk("ctrl+k", { ctrl: true }), { singleLine: true });
            yankDeleted(before);
            app.requestRender(); return;
          }
          case "d": vimPendingD = true; return;
          case "p":
            if (vimYank) {
              field.handleKey(mk("right"), { singleLine: true });
              field.paste(vimYank);
            }
            app.requestRender(); return;
          case "P":
            if (vimYank) field.paste(vimYank);
            app.requestRender(); return;
          // Mode switches
          case "i": vimInsert = true; chatLinesDirty = true; app.requestRender(); return;
          case "a":
            field.handleKey(mk("right"), { singleLine: true });
            vimInsert = true; chatLinesDirty = true; app.requestRender(); return;
          case "A":
            field.handleKey(mk("end"),  { singleLine: true });
            vimInsert = true; chatLinesDirty = true; app.requestRender(); return;
          case "I":
            field.handleKey(mk("home"), { singleLine: true });
            vimInsert = true; chatLinesDirty = true; app.requestRender(); return;
        }
      }

      return; // consume all unmatched keys in NORMAL mode
    }

    if (replState === "idle") {
      // ── @ → file picker ──────────────────────────────────────────────
      if (ev.char === "@" && !ev.ctrl && !ev.alt) {
        openFilePicker();
        return; // don't insert bare @; picker inserts "@path " on select
      }

      if (field.handleKey(ev, { singleLine: true })) {
        updateSlashSuggest();
        app.requestRender();
      }
    }
  }));

  unsubscribers.push(app.onPaste((text) => {
    if (dialog.active) return;

    // ── Detect pasted image file path ──────────────────────────────────────
    const trimmed = text.trim();
    const IMAGE_EXTS = new Set([".png", ".jpg", ".jpeg", ".gif", ".webp"]);
    const dotIdx = trimmed.lastIndexOf(".");
    const ext = dotIdx !== -1 ? trimmed.slice(dotIdx).toLowerCase() : "";
    if (IMAGE_EXTS.has(ext) && existsSync(trimmed)) {
      try {
        const imgBuf = readFileSync(trimmed);
        const b64    = imgBuf.toString("base64");
        const MIME_MAP: Record<string, string> = {
          ".png":  "image/png",
          ".jpg":  "image/jpeg",
          ".jpeg": "image/jpeg",
          ".gif":  "image/gif",
          ".webp": "image/webp",
        };
        const mime = MIME_MAP[ext] ?? "image/png";
        pendingImages.push({ path: trimmed, b64, mime });
        // Show a visual token in the input field instead of the raw path
        const filename = trimmed.split("/").pop() ?? trimmed;
        field.paste(`[Image: ${filename}] `);
        chatLinesDirty = true;
        app.requestRender();
        return;
      } catch { /* unreadable — fall through to normal paste */ }
    }

    // ── Collapse large multi-line pastes into a compact chip ───────────────
    const lineCount = text.split("\n").length;
    if (lineCount >= PASTE_LINE_THRESHOLD) {
      const id = ++pasteCounter;
      pasteStore.set(id, text);
      field.paste(`[#${id} ${lineCount} lines pasted]`);
      app.requestRender();
      return;
    }

    field.paste(text);
    app.requestRender();
  }));

  /** Is a screen point inside the editable input field's render rect? */
  const inFieldRect = (x: number, y: number): boolean =>
    !!lastFieldRect && x >= lastFieldRect.x && x < lastFieldRect.x + lastFieldRect.width &&
    y >= lastFieldRect.y && y < lastFieldRect.y + lastFieldRect.height;

  unsubscribers.push(app.onMouse((ev) => {
    // ── Input-field text selection (drag) ──────────────────────────────────
    if (ev.action === "press" && ev.button === 0 && inFieldRect(ev.x, ev.y)) {
      inputSelecting = true;
      field.selectAnchor(field.posFromScreen(ev.x, ev.y, lastFieldRect!));
      app.requestRender();
      return;
    }
    if (inputSelecting && ev.action === "move" && ev.button === 0 && lastFieldRect) {
      field.selectExtend(field.posFromScreen(ev.x, ev.y, lastFieldRect));
      app.requestRender();
      return;
    }
    if (inputSelecting && ev.action === "release" && ev.button === 0) {
      inputSelecting = false;
      const sel = field.selectedText();
      if (sel) {
        const ok = copyToClipboard(sel);
        if (!ok) pushSystemMsg("Clipboard copy failed (install pbcopy/xclip/xsel).", "error");
      }
      app.requestRender();
      return;
    }

    if (ev.action === "press" && ev.button === 0) {
      // Any click outside the field clears an input selection.
      field.clearSelection();
      // Record start of potential drag-selection in chat area
      mouseSelStartY = ev.y;
      mouseCurrentY  = null;

      // Check for tool header clicks (expand/collapse)
      const chatLineIdx = lastScrollTop + (ev.y - lastChatInnerY);
      const msgIdx = toolLineToMsgIdx.get(chatLineIdx);
      if (msgIdx !== undefined && messages[msgIdx]) {
        messages[msgIdx]!.collapsed = !messages[msgIdx]!.collapsed;
        chatLinesDirty = true;
        app.requestRender();
        return;
      }

      // Thinking header clicks (expand/collapse; default collapsed)
      const thinkIdx = thinkLineToMsgIdx.get(chatLineIdx);
      if (thinkIdx !== undefined && messages[thinkIdx]) {
        const m = messages[thinkIdx]!;
        m.thinkingCollapsed = m.thinkingCollapsed === false ? true : false;
        chatLinesDirty = true;
        app.requestRender();
        return;
      }

      const hit = hitGrid.hitTest(ev.x, ev.y);
      if (hit) {
        // Permission buttons
        if (hit.id.startsWith("perm:") && permRequest) {
          const pr = permRequest;
          permRequest = null;
          if (hit.id === "perm:yes")     pr.resolve("allow_once");
          if (hit.id === "perm:no")      pr.resolve("deny");
          if (hit.id === "perm:session") pr.resolve("allow_session");
          if (hit.id === "perm:always")  pr.resolve("allow_always");
          app.requestRender();
          return;
        }
        // Sidebar toggle (clicking the divider)
        if (hit.id === "toggle:sidebar") {
          const current = sidebarOverride !== null ? sidebarOverride : true;
          sidebarOverride = !current;
          chatLinesDirty = true;
          app.requestRender();
          return;
        }
        // Modified files toggle
        if (hit.id === "toggle:files") {
          filesExpanded = !filesExpanded;
          app.requestRender();
          return;
        }
        if (hit.id.startsWith("file:")) {
          const filePath = hit.id.slice(5);
          const editor = process.env.EDITOR || "code";
          exec(`${editor} "${filePath}"`);
        }
      }
    }
    // ── Mouse hover: change cursor shape for clickable regions ──────────
    if (ev.action === "move" && mouseSelStartY === null) {
      const hit = hitGrid.hitTest(ev.x, ev.y);
      const isClickable = hit && (
        hit.id === "toggle:sidebar" ||
        hit.id === "toggle:files" ||
        hit.id.startsWith("perm:") ||
        hit.id.startsWith("file:")
      );
      if (isClickable && !lastPointerIsHand) {
        process.stdout.write("\x1b]22;pointer\x07");
        lastPointerIsHand = true;
      } else if (!isClickable && lastPointerIsHand) {
        process.stdout.write("\x1b]22;\x07");
        lastPointerIsHand = false;
      }
    }
    // ── Mouse drag: update live highlight ────────────────────────────────
    if (ev.action === "move" && ev.button === 0 && mouseSelStartY !== null) {
      mouseCurrentY = ev.y;
      app.requestRender();
      return;
    }
    // ── Mouse drag-to-copy: release at a different row than press ────────
    if (ev.action === "release" && ev.button === 0) {
      const startY = mouseSelStartY;
      mouseSelStartY = null;
      mouseCurrentY  = null;
      if (startY !== null && Math.abs(ev.y - startY) >= 1) {
        // Both press and release must be inside the chat area
        const chatTop = lastChatInnerY;
        if (startY >= chatTop && ev.y >= chatTop) {
          const rowA = Math.min(startY, ev.y) - chatTop;
          const rowB = Math.max(startY, ev.y) - chatTop;
          const firstLine = lastScrollTop + rowA;
          const lastLine  = lastScrollTop + rowB;
          const slice = cachedChatLines.slice(
            Math.max(0, firstLine),
            Math.min(cachedChatLines.length, lastLine + 1),
          );
          if (slice.length > 0) {
            const text = styledLinesToText(slice);
            const ok = copyToClipboard(text);
            pushSystemMsg(ok
              ? `Copied ${slice.length} line${slice.length === 1 ? "" : "s"} to clipboard.`
              : "Clipboard copy failed (install pbcopy/xclip/xsel).",
            );
            chatLinesDirty = true;
          }
        }
      }
      app.requestRender();
    }
    if (ev.button === 64) {
      chatAutoScroll = false;
      chatSV.scroll(-3, cachedChatLines.length, 10);
      app.requestRender();
    } else if (ev.button === 65) {
      chatSV.scroll(3, cachedChatLines.length, 10);
      const maxTop = Math.max(0, cachedChatLines.length - 10);
      if (chatSV.scrollTop >= maxTop) chatAutoScroll = true;
      app.requestRender();
    }
  }));

  const resizeHandler = () => {
    chatLinesDirty = true;
    app.requestRender();
  };
  app.on("resize", resizeHandler);
  unsubscribers.push(() => { app.removeListener("resize", resizeHandler); });

  // ─── Start ────────────────────────────────────────────────────────────────

  spinner.start(() => { if (busy()) app.requestRender(); });
  pulse.start(() => { if (busy()) app.requestRender(); });

  // Fetch lifetime stats in background (non-blocking — sidebar shows "Fetching…" until done)
  void fetchLifetimeStats();

  // Update check (cached 4h, fail-silent) — one dim notice line if newer exists
  void checkForUpdate().then((u) => {
    if (u?.updateAvailable) {
      pushSystemMsg(`Update available: v${u.current} → **v${u.latest}** — run \`klaatai upgrade\`.`);
      app.requestRender();
    }
  });

  // ─── Graph indexer (background, non-blocking) ─────────────────────────────
  initLocalDb();
  const _proj = resolveProjectId(projectRoot);
  if (_proj) client.setProjectId(_proj.id);

  const _kgIndexer = new KGIndexer(client);
  const refreshGraphStats = (indexing: boolean, p?: IndexProgress) => {
    const s = _proj ? localDbGetStats(_proj.id) : null;
    graphStats = {
      indexing,
      indexed: p?.indexed ?? 0,
      total: p?.total ?? 0,
      files: s?.fileCount ?? p?.projectFiles ?? 0,
      symbols: s?.symbolCount ?? p?.symbols ?? 0,
      edges: s?.edgeCount ?? p?.edges ?? 0,
      embedded: s?.embeddedCount ?? 0,
    };
  };
  _kgIndexer.onProgress((p: IndexProgress) => {
    if (p.status === "scanning" || p.status === "indexing") {
      graphStatus = p.status === "scanning" ? "⟳ Indexing…" : `⟳ ${p.indexed}/${p.total} files`;
      refreshGraphStats(true, p);
    } else if (p.status === "done") {
      graphStatus = `✓ ${p.projectFiles} files`;
      refreshGraphStats(false, p);
      // Embeddings finish asynchronously — poll stats a few times to catch them.
      for (const delay of [4000, 10000, 20000]) {
        setTimeout(() => { refreshGraphStats(false); app.requestRender(); }, delay);
      }
      setTimeout(() => { graphStatus = ""; app.requestRender(); }, 4000);
    } else if (p.status === "error") {
      graphStatus = "";
      refreshGraphStats(false, p);
    }
    app.requestRender();
  });
  void _kgIndexer.indexWorkspace(projectRoot);

  // Switch the app's render function to our full-screen REPL
  app.setRenderFn(render);

  // Auto-resume if --resume flag was passed (ID resolved by pre-boot picker or directly)
  if (opts.resumeId) {
    const sessions = getSessionList();
    const target = opts.resumeId === "last"
      ? sessions[0]
      : sessions.find(s => s.id.includes(opts.resumeId!));
    if (target) {
      const { msgs, apiMsgs } = loadSessionFromFile(target.file);
      messages.splice(0, messages.length, ...msgs);
      apiMessages = [...apiMessages.slice(0, apiMessages.findIndex(m => m.role !== "system") || 1), ...apiMsgs];
      chatLinesDirty = true;
      chatAutoScroll = true;
      pushSystemMsg(`Resumed session **${target.id}** — ${msgs.length} messages loaded.`);
    } else {
      pushSystemMsg(`No session matching "${opts.resumeId}". Starting fresh.`, "error");
    }
  }

  // Wait until quit() is called
  await new Promise<void>((resolve) => {
    _resolveQuit = resolve;
  });

  return { sessionId };
}
