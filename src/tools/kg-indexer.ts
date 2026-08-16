/**
 * CLI Knowledge-graph indexer — runs silently in the background after login.
 *
 * Paywall model (G3, 2026-08-15 — local graph for ALL tiers):
 *   - Local SQLite index is populated for every authenticated user. Local
 *     build/store/query costs us nothing, and graph-first retrieval saves us
 *     tokens on exactly the tiers that burn the most per task.
 *   - The server copy is the paid layer: /index soft-caps free accounts and
 *     may 402/403; that gates SERVER sync only — local indexing always
 *     completes. Cross-device graphs, pre-warm, and semantic embeddings
 *     remain the Pro+ perks.
 */

import { createHash } from "node:crypto";
import { readFileSync, existsSync } from "node:fs";
import { join, relative } from "node:path";
import { readdirSync, statSync } from "node:fs";
import { resolveProjectId, type ProjectInfo } from "../utils/project-id.js";
import { extractSymbols, extractCallEdges } from "./regex-symbols.js";
import { extractDocSections } from "./doc-sections.js";
import { initTreeSitter, parseWithTreeSitter } from "./treesitter.js";
import {
  localDbDiff, localDbIndexFiles, localDbIndexEdges,
  localDbGetSymbolsForEmbedding, localDbGetUnembeddedSymbols, localDbWriteEmbeddings,
  localDbFileGraph, localDbWriteCommunities,
} from "./local-db.js";
import { detectCommunities, labelCommunities } from "./graph-communities.js";
import { embedPassages } from "./code-embedder.js";
import type { KlaatAIClient } from "../api/client.js";

const FILE_BATCH = 40;
const GLOB_EXTS = new Set([
  "ts", "tsx", "js", "jsx", "mts", "cts", "mjs", "cjs",
  "py", "go", "rs", "java", "kt", "kts", "swift", "php", "rb", "cs",
  "c", "h", "cc", "cpp", "cxx", "hpp", "m", "mm",
  "vue", "svelte", "scala", "dart", "lua", "ex", "exs", "sh", "bash",
  "md", "mdx", // G4b: docs enter the graph as heading-section nodes
]);
const EXCLUDE_DIRS = new Set([
  "node_modules", ".git", "dist", "build", ".next", "out",
  "target", "vendor", "coverage", ".venv", "__pycache__",
]);

const LANG_BY_EXT: Record<string, string> = {
  ts: "typescript", tsx: "typescript", mts: "typescript", cts: "typescript",
  js: "javascript", jsx: "javascript", mjs: "javascript", cjs: "javascript",
  py: "python", go: "go", rs: "rust", java: "java", kt: "kotlin", kts: "kotlin",
  swift: "swift", php: "php", rb: "ruby", cs: "csharp",
  md: "markdown", mdx: "markdown",
};

export type IndexStatus = "idle" | "scanning" | "indexing" | "done" | "error";

type BuiltFile = NonNullable<Awaited<ReturnType<typeof _buildFile>>>;

export interface IndexProgress {
  status: IndexStatus;
  indexed: number;
  total: number;
  projectFiles: number;
  symbols: number;
  edges: number;
  projectName?: string;
  message?: string;
}

type ProgressCallback = (p: IndexProgress) => void;

export class KGIndexer {
  private _client: KlaatAIClient;
  private _listeners: ProgressCallback[] = [];
  private _state: IndexProgress = { status: "idle", indexed: 0, total: 0, projectFiles: 0, symbols: 0, edges: 0 };
  private _running = false;
  private _lastRun = 0;

  constructor(client: KlaatAIClient) {
    this._client = client;
  }

  onProgress(cb: ProgressCallback): () => void {
    this._listeners.push(cb);
    return () => { this._listeners = this._listeners.filter((l) => l !== cb); };
  }

  get state(): IndexProgress { return this._state; }

  private _emit(patch: Partial<IndexProgress>): void {
    this._state = { ...this._state, ...patch };
    for (const cb of this._listeners) cb(this._state);
  }

  /** Index the workspace. Safe to call often — throttled to once/minute unless forced. */
  async indexWorkspace(projectRoot: string, force = false): Promise<void> {
    if (this._running) return;
    if (!force && Date.now() - this._lastRun < 60_000) return;

    const proj = resolveProjectId(projectRoot);
    if (!proj) return;

    this._running = true;
    this._lastRun = Date.now();
    this._emit({ status: "scanning", indexed: 0, total: 0, symbols: 0, projectFiles: 0, projectName: proj.name });

    try {
      const uris = _walkFiles(projectRoot);
      if (uris.length === 0) {
        this._emit({ status: "done", message: "No indexable files found" });
        return;
      }

      // Hash every file.
      const hashed: { relPath: string; absPath: string; hash: string }[] = [];
      for (const absPath of uris) {
        try {
          const bytes = readFileSync(absPath);
          hashed.push({
            absPath,
            relPath: relative(projectRoot, absPath),
            hash: createHash("sha256").update(bytes).digest("hex"),
          });
        } catch { /* unreadable — skip */ }
      }
      this._emit({ projectFiles: hashed.length });

      // Diff — local first, server fallback.
      let stalePaths: string[];
      if (force) {
        stalePaths = hashed.map((h) => h.relPath);
      } else {
        const localStale = localDbDiff(proj.id, hashed.map((h) => ({ path: h.relPath, hash: h.hash })));
        if (localStale.length < hashed.length) {
          stalePaths = localStale;
        } else {
          try {
            stalePaths = await this._client.graphDiff(
              proj.id,
              hashed.map((h) => ({ path: h.relPath, hash: h.hash })),
            );
          } catch {
            stalePaths = hashed.map((h) => h.relPath);
          }
        }
      }

      const staleSet = new Set(stalePaths);
      const stale = hashed.filter((h) => staleSet.has(h.relPath));

      if (stale.length === 0) {
        this._emit({ status: "done", indexed: 0, total: 0, message: `Up to date (${hashed.length} files)` });
        return;
      }

      this._emit({ status: "indexing", total: stale.length, indexed: 0 });
      let indexed = 0;
      let symbols = 0;
      // Plan gate tripped: stop TALKING to the server, keep indexing locally.
      // The old behaviour aborted the whole run here, which threw away the
      // local graph for exactly the users whose grep/read fallback costs the
      // most tokens.
      let serverGated = false;

      await initTreeSitter(); // one-time; falls back to regex permanently on failure

      const allBuilt: BuiltFile[] = [];
      for (let i = 0; i < stale.length; i += FILE_BATCH) {
        const batch = stale.slice(i, i + FILE_BATCH);
        const built = (await Promise.all(
          batch.map((f) => _buildFile(f.absPath, f.relPath, f.hash)),
        )).filter((f): f is BuiltFile => f !== null);
        allBuilt.push(...built);

        const batchSymbols = built.reduce((n, f) => n + f.symbols.length, 0);

        // Write to local DB — single WAL transaction per batch.
        try {
          localDbIndexFiles(proj.id, proj.name, proj.rootPath, proj.gitRemote, built);
        } catch { /* non-fatal */ }

        // Upload to server — best-effort. 402/403 = plan gate on the SERVER
        // copy only; 5xx = transient. Neither stops local indexing.
        if (!serverGated) {
          const res = await this._client.graphIndex(proj.id, {
            project_name: proj.name,
            root_path: proj.rootPath,
            git_remote: proj.gitRemote,
            total_files: hashed.length,
            files: built,
          });
          if (res.status === 403 || res.status === 402) {
            serverGated = true;
          }
        }

        indexed += batch.length;
        symbols += batchSymbols;
        this._emit({ indexed, symbols, message: `Indexed ${indexed} of ${stale.length} file(s)` });
      }

      // Build call-graph edges from the already-parsed files (no re-parse).
      const localEdges: { from: string; fromFile: string; to: string }[] = [];
      const serverEdges: { from_name: string; from_file: string; to_name: string; to_file: string; kind: string; source: string }[] = [];
      for (const b of allBuilt) {
        for (const [caller, callees] of Object.entries(b.calls ?? {})) {
          for (const callee of callees) {
            localEdges.push({ from: caller, fromFile: b.path, to: callee });
            serverEdges.push({ from_name: caller, from_file: b.path, to_name: callee, to_file: "", kind: "calls", source: "regex" });
          }
        }
      }
      let edgeCount = 0;
      if (localEdges.length > 0) {
        try {
          localDbIndexEdges(proj.id, allBuilt.map((b) => b.path), localEdges);
          edgeCount = localEdges.length;
        } catch { /* non-fatal */ }
        // Push to server /edges in capped batches (best-effort; skipped once
        // the plan gate fired — symbols aren't there for edges to resolve to).
        if (!serverGated) {
          try {
            for (let i = 0; i < serverEdges.length; i += 200) {
              await this._client.graphEdges(proj.id, serverEdges.slice(i, i + 200));
            }
          } catch { /* non-fatal */ }
        }
      }

      _recomputeCommunities(proj.id);

      this._emit({
        status: "done", indexed, total: stale.length, symbols, edges: edgeCount,
        message: `Indexed ${indexed} file(s), ${symbols} symbol(s), ${edgeCount} edge(s)` +
          (serverGated ? " — local graph ready; cross-device sync requires Pro" : ""),
      });

      // Fire-and-forget embedding pass (non-blocking)
      void this._embedChangedSymbols(proj.id, allBuilt.map((b) => b.path));
    } catch (e) {
      this._emit({ status: "error", message: `Indexing failed: ${String(e)}` });
    } finally {
      this._running = false;
    }
  }

  /**
   * Incremental (G3): reindex just these files after an agent edit — the graph
   * must not go stale the moment the agent starts changing code, or every
   * graph answer about edited files is wrong until the next full run.
   *
   * Local-only by design: the server sync happens on the next full run
   * (session start). An incremental /index upload would clobber the project's
   * total_files stat with a tiny number, and freshness is a LOCAL problem.
   */
  async indexFilePaths(projectRoot: string, absPaths: string[]): Promise<void> {
    if (this._running) return; // a full run is in flight and will cover these
    const proj = resolveProjectId(projectRoot);
    if (!proj) return;
    this._running = true;
    try {
      await initTreeSitter();
      const built: BuiltFile[] = [];
      for (const absPath of absPaths) {
        if (!existsSync(absPath)) continue; // deleted — next full run prunes it
        try {
          const bytes = readFileSync(absPath);
          const hash = createHash("sha256").update(bytes).digest("hex");
          const b = await _buildFile(absPath, relative(projectRoot, absPath), hash);
          if (b) built.push(b);
        } catch { /* unreadable — skip */ }
      }
      if (built.length === 0) return;

      try {
        localDbIndexFiles(proj.id, proj.name, proj.rootPath, proj.gitRemote, built);
      } catch { /* non-fatal */ }

      const localEdges: { from: string; fromFile: string; to: string }[] = [];
      for (const b of built) {
        for (const [caller, callees] of Object.entries(b.calls ?? {})) {
          for (const callee of callees) localEdges.push({ from: caller, fromFile: b.path, to: callee });
        }
      }
      if (localEdges.length > 0) {
        try { localDbIndexEdges(proj.id, built.map((b) => b.path), localEdges); } catch { /* non-fatal */ }
      }
      _recomputeCommunities(proj.id);

      void this._embedChangedSymbols(proj.id, built.map((b) => b.path));
    } finally {
      this._running = false;
    }
  }

  private async _embedChangedSymbols(projectId: string, changedFilePaths: string[]): Promise<void> {
    try {
      const token = this._client.token;
      const serverUrl = this._client.serverUrl;

      const fromChanged = changedFilePaths.length > 0
        ? localDbGetSymbolsForEmbedding(projectId, changedFilePaths) : [];
      const unembedded = localDbGetUnembeddedSymbols(projectId);
      const seen = new Set<number>(fromChanged.map((s) => s.id));
      const syms = [...fromChanged, ...unembedded.filter((s) => !seen.has(s.id))];
      if (syms.length === 0) return;

      const texts = syms.map((s) =>
        `${s.kind} ${s.name} (${s.file})${s.signature ? ": " + s.signature.slice(0, 200) : ""}`
      );
      const embeddings = await embedPassages(texts, token, serverUrl);
      const toWrite = syms
        .map((s, i) => ({ id: s.id, embedding: embeddings[i] }))
        .filter((r) => r.embedding instanceof Float32Array);
      localDbWriteEmbeddings(toWrite);
    } catch {
      // Embedding failure is non-fatal — structural graph still works
    }
  }
}

// ─── Community recompute (G4) ────────────────────────────────────────────────
// Louvain over the file graph after every index write. A few hundred nodes —
// milliseconds — so freshness beats cleverness; capped defensively for
// monorepos where the file graph itself is huge.

const MAX_COMMUNITY_NODES = 5_000;

function _recomputeCommunities(projectId: string): void {
  try {
    const g = localDbFileGraph(projectId);
    if (g.nodes.length === 0 || g.nodes.length > MAX_COMMUNITY_NODES) return;
    const assign = detectCommunities(g.nodes, g.edges);
    const labels = labelCommunities(assign);
    localDbWriteCommunities(
      projectId,
      [...assign].map(([path, community]) => ({
        path, community, label: labels.get(community) ?? "",
      })),
    );
  } catch { /* non-fatal — graph works without communities */ }
}

// ─── Incremental reindex queue (G3) ──────────────────────────────────────────
// The tool layer (write_file/edit_file/multi_edit) notes mutations here; the
// REPL's indexer instance registers itself and drains the queue on a debounce.
// Decoupled so tools/index.ts never needs a client or an indexer reference.

let _incIndexer: KGIndexer | null = null;
let _incRoot = "";
const _incPending = new Set<string>();
let _incTimer: ReturnType<typeof setTimeout> | null = null;
const INCREMENTAL_DEBOUNCE_MS = 2_000;

/** Called once by the session owner (repl) after constructing its KGIndexer. */
export function enableIncrementalReindex(indexer: KGIndexer, projectRoot: string): void {
  _incIndexer = indexer;
  _incRoot = projectRoot;
}

/** Note a mutated file; batched + debounced so an edit burst indexes once. */
export function noteFileMutated(absPath: string): void {
  if (!_incIndexer || !absPath.startsWith(_incRoot)) return;
  const ext = absPath.split(".").pop()?.toLowerCase() ?? "";
  if (!GLOB_EXTS.has(ext)) return;
  _incPending.add(absPath);
  if (_incTimer) clearTimeout(_incTimer);
  _incTimer = setTimeout(() => {
    _incTimer = null;
    const paths = [..._incPending];
    _incPending.clear();
    void _incIndexer?.indexFilePaths(_incRoot, paths);
  }, INCREMENTAL_DEBOUNCE_MS);
  // Never keep the process alive just for a pending reindex.
  (_incTimer as { unref?: () => void }).unref?.();
}

// ─── Helpers ──────────────────────────────────────────────────────────────────

function _walkFiles(dir: string): string[] {
  const results: string[] = [];
  function walk(d: string): void {
    let entries: string[];
    try { entries = readdirSync(d); } catch { return; }
    for (const e of entries) {
      if (e.startsWith(".") && e !== ".klaatai") continue;
      const full = join(d, e);
      let st;
      try { st = statSync(full); } catch { continue; }
      if (st.isDirectory()) {
        if (!EXCLUDE_DIRS.has(e)) walk(full);
      } else {
        const ext = e.split(".").pop()?.toLowerCase() ?? "";
        if (GLOB_EXTS.has(ext)) results.push(full);
      }
    }
  }
  walk(dir);
  return results;
}

async function _buildFile(
  absPath: string,
  relPath: string,
  hash: string,
): Promise<{ path: string; language: string; hash: string; symbols: ReturnType<typeof extractSymbols>; calls: Record<string, string[]> } | null> {
  const ext = relPath.split(".").pop()?.toLowerCase() ?? "";
  const language = LANG_BY_EXT[ext] ?? ext;
  try {
    const text = readFileSync(absPath, "utf-8");
    // G4b: markdown has no tree-sitter grammar loaded — its "symbols" are
    // heading sections, and docs have no call edges.
    if (ext === "md" || ext === "mdx") {
      const base = relPath.split(/[\\/]/).pop() ?? relPath;
      return { path: relPath, language, hash, symbols: extractDocSections(text, base), calls: {} };
    }
    // Tree-sitter first (exact spans, methods, nested + call edges — G3);
    // regex fallback keeps behaviour identical when wasm is unavailable.
    const parsed = await parseWithTreeSitter(ext, text);
    const symbols = parsed ? parsed.symbols : extractSymbols(language, ext, text);
    const calls = parsed ? parsed.calls : extractCallEdges(text, symbols);
    return { path: relPath, language, hash, symbols, calls };
  } catch {
    return { path: relPath, language, hash, symbols: [], calls: {} };
  }
}
