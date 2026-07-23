/**
 * KlaatAI API client — wraps /v1/chat/completions and /health.
 *
 * Handles:
 *   - Auth (API key header)
 *   - SSE streaming (text/event-stream)
 *   - Non-streaming JSON responses
 *   - Tool calls passthrough
 *   - x_klaatai metadata (tier, model, cost)
 */

export interface Message {
  role: "system" | "user" | "assistant" | "tool";
  content: string | ContentPart[];
  tool_calls?: ToolCall[];
  tool_call_id?: string;
}

export interface ContentPart {
  type: "text" | "image_url";
  text?: string;
  image_url?: { url: string };
}

export interface ToolCall {
  id: string;
  type: "function";
  function: { name: string; arguments: string };
}

export interface ToolDefinition {
  type: "function";
  function: {
    name: string;
    description: string;
    parameters: Record<string, unknown>;
  };
}

/** Server doom-loop detection (D6) — sent on the final SSE chunk when the
 * CURRENT response repeats the same trailing tool round yet again. */
export interface LoopSignal {
  kind: string;               // "tool_repetition"
  count: number;              // consecutive identical rounds
  tools?: string[];           // tool names involved
  results_identical?: boolean; // true = act (abort round); false = warn only
}

export interface KlaatAIMetadata {
  tier: string;
  reason: string;
  model: string;
  provider: string;
  cascade_position: number;
  loop_signal?: LoopSignal;
}

export interface ChatResponse {
  id: string;
  choices: Array<{
    message: { role: string; content: string | null; tool_calls?: ToolCall[] };
    finish_reason: string;
  }>;
  usage: { prompt_tokens: number; completion_tokens: number; total_tokens: number; cached_tokens?: number };
  x_klaatai?: KlaatAIMetadata;
}

/** Weighted-unit quota snapshot from response headers (E1). */
export interface QuotaSnapshot {
  unitsUsed?: number;
  unitsLimit?: number;
  requestsUsed?: number;   // legacy count headers, still sent
  requestsLimit?: number;
  plan?: string;
  tier?: string;           // X-KlaatAI-Tier (authoritative served tier)
  /** X-KlaatAI-Stream-Mode: "live" (A2 passthrough) or "buffered" fallback. */
  streamMode?: string;
  /** X-KlaatAI-Loop-Signal: e.g. "tool_repetition:3" — the transcript the
   * server RECEIVED already ended in n identical tool rounds (warn-level;
   * the actionable per-response signal arrives in metadata.loop_signal). */
  loopSignal?: string;
}

export interface StreamChunk {
  type: "token" | "tool_call" | "done" | "error" | "metadata" | "quota";
  text?: string;
  tool_calls?: ToolCall[];
  metadata?: KlaatAIMetadata;
  usage?: { prompt_tokens: number; completion_tokens: number; total_tokens: number; cached_tokens?: number };
  quota?: QuotaSnapshot;
  error?: string;
}

export interface TierUsage {
  requests: number;
  prompt_tokens: number;
  completion_tokens: number;
  total_tokens: number;
  cost_usd: number;
}

export interface LifetimeUsageStats {
  total_requests: number;
  prompt_tokens: number;
  completion_tokens: number;
  total_tokens: number;
  total_cost_usd: number;
  by_tier: Record<string, TierUsage>;
}

export interface ClientOptions {
  apiKey: string;
  baseUrl?: string;
  model?: string;
  /**
   * Called when a request gets 401 — should return a fresh token
   * (via silent refresh or full browser re-login). Null = give up.
   */
  onAuthExpired?: () => Promise<string | null>;
}

/**
 * Sanitize API/server error messages for end-user display.
 * Never expose internal provider names, raw JSON, or server internals.
 */
export function sanitizeError(raw: string, status?: number): string {
  const lower = raw.toLowerCase()

  if (status === 402 || lower.includes('balance') || lower.includes('payment required') || lower.includes('quota')) {
    return 'Your usage quota has been reached. Please check your plan at klaatai.com.'
  }
  if (status === 429 || lower.includes('rate limit') || lower.includes('too many requests')) {
    return 'Too many requests — please wait a moment and try again.'
  }
  if (status === 401 || lower.includes('unauthorized') || lower.includes('invalid') && lower.includes('token')) {
    return 'Session expired. Please sign in again.'
  }
  if (status === 502 || status === 503 || status === 504 || lower.includes('bad gateway') || lower.includes('service unavailable')) {
    return 'KlaatAI is temporarily unavailable. Try again shortly.'
  }
  if (status === 500 || lower.includes('internal server')) {
    return 'Something went wrong on our end. Please try again.'
  }
  if (lower.includes('all models failed') || lower.includes('tool passthrough')) {
    return 'KlaatAI is busy right now. Please try again in a moment.'
  }
  if (lower.includes('fetch failed') || lower.includes('econnrefused') || lower.includes('enotfound') || lower.includes('network')) {
    return 'Could not connect to KlaatAI. Check your internet connection.'
  }
  if (lower.includes('abort') || lower.includes('cancelled') || lower.includes('interrupted')) {
    return 'Request was interrupted.'
  }
  if (lower.includes('no response')) {
    return 'No response received. Please try again.'
  }
  return 'Something went wrong. Please try again.'
}

/**
 * Tier forcing speaks the server's model-alias protocol: Klaatu maps
 * body.model aliases to forced tiers (_OAI_MODEL_ROUTING in server.py) and
 * ignores any custom body fields. Unknown aliases safely fall back to auto
 * routing server-side ("klaatu-heavy"/"klaatu-nano" need Klaatu P1-9).
 */
const TIER_MODEL_ALIAS: Record<string, string> = {
  nano:   "klaatu-nano",
  fast:   "klaatu-fast",
  code:   "klaatu-code",
  reason: "klaatu-reason",
  heavy:  "klaatu-heavy",
};

/** Client-observed model-quality feedback (X-KlaatAI-Model-Feedback, E3). */
export interface ModelFeedback {
  model_id: string;
  error_type:
    | "tool_validation" | "schema_error" | "bash_schema"
    | "edit_failure" | "edit_fuzzy_rescue"
    | "retry" | "user_retry" | "timeout" | "empty_response" | "failure";
  tier?: string;
  detail?: string;
  pass?: string;
}

/** A user-configured third-party OpenAI-compatible endpoint (see /model add). */
export interface CustomEndpoint {
  name: string;
  baseUrl: string;
  model: string;
  apiKey: string;
}

export class KlaatAIClient {
  private apiKey: string;
  private baseUrl: string;
  private model: string;
  private _projectId: string | null = null;
  private _sessionId: string;
  private _pendingFeedback: ModelFeedback | null = null;
  private _onAuthExpired: (() => Promise<string | null>) | null;
  private _custom: CustomEndpoint | null = null;

  constructor(opts: ClientOptions) {
    this.apiKey = opts.apiKey;
    this.baseUrl = (opts.baseUrl ?? "https://api.klaatai.com").replace(/\/$/, "");
    this.model = opts.model ?? "klaatu";
    this._sessionId = crypto.randomUUID();
    this._onAuthExpired = opts.onAuthExpired ?? null;
  }

  /** Update the stored token (called after successful refresh/re-login). */
  updateToken(token: string): void { this.apiKey = token; }

  /**
   * Route chat requests to a third-party OpenAI-compatible endpoint instead of
   * Klaatu (null restores Klaatu). Graph/quota/feedback APIs always stay on
   * Klaatu — only chat/chatStream are redirected.
   */
  setCustomEndpoint(ep: CustomEndpoint | null): void { this._custom = ep; }
  get customEndpoint(): CustomEndpoint | null { return this._custom; }

  /** Chat URL + headers + model for the active endpoint (custom or Klaatu). */
  private chatTarget(extra?: Record<string, string>): { url: string; headers: Record<string, string>; model: string } {
    if (this._custom) {
      const base = this._custom.baseUrl.replace(/\/$/, "");
      const url = /\/v\d+$/.test(base) ? `${base}/chat/completions` : `${base}/v1/chat/completions`;
      return {
        url,
        // Minimal headers only — third-party servers may reject Klaatu extras.
        headers: {
          "Authorization": `Bearer ${this._custom.apiKey}`,
          "Content-Type": "application/json",
        },
        model: this._custom.model,
      };
    }
    return {
      url: `${this.baseUrl}/v1/chat/completions`,
      headers: this.headers(extra),
      model: this.model,
    };
  }

  /**
   * Attempt to recover from a 401 by calling the onAuthExpired hook.
   * Returns true if the token was refreshed (caller should retry).
   */
  private async tryRecoverAuth(): Promise<boolean> {
    if (!this._onAuthExpired) return false;
    const newToken = await this._onAuthExpired();
    if (newToken) { this.apiKey = newToken; return true; }
    return false;
  }

  /** Set project-id for graph pre-warm header. */
  setProjectId(id: string | null): void { this._projectId = id; }

  /** Override the session-affinity id (e.g. resumed session). */
  setSessionId(id: string): void { if (id) this._sessionId = id; }
  get sessionId(): string { return this._sessionId; }

  /**
   * Queue one model-quality signal for the next chat request. Keeps only the
   * most severe pending observation (failure > validation/edit > retry/rescue).
   */
  queueFeedback(fb: ModelFeedback): void {
    if (!fb?.model_id) return;
    const sev = (t: ModelFeedback["error_type"]): number =>
      t === "timeout" || t === "empty_response" || t === "failure" ? 3
      : t === "edit_failure" || t === "tool_validation" || t === "schema_error" || t === "bash_schema" ? 2
      : 1;
    if (!this._pendingFeedback || sev(fb.error_type) >= sev(this._pendingFeedback.error_type)) {
      this._pendingFeedback = fb;
    }
  }

  /** Serialize + clear pending feedback for a request header (≤4 KB). */
  private takeFeedbackHeader(): string | null {
    if (!this._pendingFeedback) return null;
    const fb = this._pendingFeedback;
    this._pendingFeedback = null;
    if (fb.detail && fb.detail.length > 300) fb.detail = fb.detail.slice(0, 300);
    try { return JSON.stringify(fb); } catch { return null; }
  }

  /** Standalone feedback POST (when there is no next chat request). */
  async sendFeedback(fb: ModelFeedback): Promise<void> {
    if (!fb?.model_id) return;
    try {
      await fetch(`${this.baseUrl}/v1/routing/feedback`, {
        method: "POST",
        headers: this.headers(),
        body: JSON.stringify(fb),
      });
    } catch { /* fire-and-forget */ }
  }

  get token(): string { return this.apiKey; }
  get serverUrl(): string { return this.baseUrl; }

  private headers(extra?: Record<string, string>): Record<string, string> {
    const h: Record<string, string> = {
      "Authorization": `Bearer ${this.apiKey}`,
      "Content-Type": "application/json",
      "X-KlaatAI-Client": "klaatcode",
      // Stable session identity (A3 stickiness + C2 checkpoint cache).
      "X-Session-Affinity": this._sessionId,
      // We retention-compact the transcript client-side before every request,
      // so ask the server to trust it and skip its own blind truncation
      // (honored once Klaatu C3 lands; harmless otherwise).
      "X-KlaatAI-Compaction": "client",
    };
    if (this._projectId) h["X-KlaatAI-Project"] = this._projectId;
    if (extra) Object.assign(h, extra);
    return h;
  }

  // ─── Graph API ──────────────────────────────────────────────────────────────

  /** Stale-file detection — returns paths whose stored hash differs. */
  async graphDiff(projectId: string, files: { path: string; hash: string }[]): Promise<string[]> {
    const res = await fetch(`${this.baseUrl}/v1/graph/projects/${projectId}/diff`, {
      method: "POST",
      headers: this.headers(),
      body: JSON.stringify({ files }),
    });
    if (!res.ok) {
      throw new Error(sanitizeError('', res.status));
    }
    const data = await res.json() as { stale?: string[] };
    return data.stale ?? [];
  }

  /** Upload symbols for a batch of files. Returns {ok, status, detail?}. */
  async graphIndex(
    projectId: string,
    body: {
      project_name: string;
      root_path?: string;
      git_remote?: string | null;
      total_files?: number;
      files: {
        path: string; language: string; hash: string;
        symbols: { name: string; kind: string; signature?: string; start_line: number; end_line: number; is_exported?: boolean }[];
      }[];
    },
  ): Promise<{ ok: boolean; status: number; detail?: string }> {
    const res = await fetch(`${this.baseUrl}/v1/graph/projects/${projectId}/index`, {
      method: "POST",
      headers: this.headers(),
      body: JSON.stringify(body),
    });
    if (res.ok) return { ok: true, status: res.status };
    const detail = await res.text().catch(() => "");
    return { ok: false, status: res.status, detail: detail.slice(0, 300) };
  }

  /** Upload call-graph edges. */
  async graphEdges(
    projectId: string,
    edges: { from_name: string; from_file: string; to_name: string; to_file: string; kind: string; source: string }[],
  ): Promise<{ ok: boolean; status: number }> {
    const res = await fetch(`${this.baseUrl}/v1/graph/projects/${projectId}/edges`, {
      method: "POST",
      headers: this.headers(),
      body: JSON.stringify({ edges }),
    });
    return { ok: res.ok, status: res.status };
  }

  /** Symbol search across the project graph. */
  async graphQuery(projectId: string, query: string, kind?: string, limit = 10): Promise<Response> {
    const params = new URLSearchParams({ q: query, limit: String(Math.min(Math.max(limit, 1), 30)) });
    if (kind && kind !== "all") params.set("kind", kind);
    return fetch(`${this.baseUrl}/v1/graph/projects/${projectId}/query?${params}`, { headers: this.headers() });
  }

  /** File outline from the graph. */
  async graphOutline(projectId: string, filePath: string): Promise<Response> {
    const params = new URLSearchParams({ file_path: filePath });
    return fetch(`${this.baseUrl}/v1/graph/projects/${projectId}/outline?${params}`, { headers: this.headers() });
  }

  /** Blast-radius impact check. */
  async graphImpact(projectId: string, symbol: string, filePath?: string): Promise<Response> {
    const params = new URLSearchParams({ symbol });
    if (filePath) params.set("file_path", filePath);
    return fetch(`${this.baseUrl}/v1/graph/projects/${projectId}/impact?${params}`, {
      method: "POST",
      headers: this.headers(),
    });
  }

  /**
   * Server-side web search (Tavily proxy). Returns null on any failure so
   * callers can fall back to a local search implementation.
   */
  async webSearch(query: string, maxResults = 8): Promise<{
    results: { title?: string; url?: string; content?: string }[];
    answer?: string;
  } | null> {
    try {
      const res = await fetch(`${this.baseUrl}/v1/tools/websearch`, {
        method: "POST",
        headers: this.headers({ "Content-Type": "application/json" }),
        body: JSON.stringify({ query, max_results: maxResults }),
      });
      if (!res.ok) return null;
      const data = await res.json() as {
        results?: { title?: string; url?: string; content?: string }[];
        answer?: string;
      };
      if (!Array.isArray(data.results)) return null;
      return { results: data.results, answer: data.answer };
    } catch {
      return null;
    }
  }

  /** Health check with timeout — returns { status: "ok" } or throws. */
  async ping(timeoutMs = 10_000): Promise<{ status: string }> {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    try {
      const res = await fetch(`${this.baseUrl}/health`, {
        headers: this.headers(),
        signal: controller.signal,
      });
      if (!res.ok) throw new Error(`Health check failed: ${res.status}`);
      return res.json() as Promise<{ status: string }>;
    } finally {
      clearTimeout(timer);
    }
  }

  /**
   * Fetch lifetime aggregate usage stats for the authenticated user.
   * Returns null silently on network error or 4xx (e.g. if backend not upgraded yet).
   */
  async getUsageStats(): Promise<LifetimeUsageStats | null> {
    try {
      let res = await fetch(`${this.baseUrl}/v1/me/usage`, {
        headers: this.headers(),
      });
      if (res.status === 401 && await this.tryRecoverAuth()) {
        res = await fetch(`${this.baseUrl}/v1/me/usage`, { headers: this.headers() });
      }
      if (!res.ok) return null;
      return res.json() as Promise<LifetimeUsageStats>;
    } catch {
      return null;
    }
  }

  /**
   * Non-streaming chat completion.
   * Returns the full response after the model finishes.
   */
  async chat(
    messages: Message[],
    opts: {
      tools?: ToolDefinition[];
      maxTokens?: number;
      temperature?: number;
    } = {}
  ): Promise<ChatResponse> {
    const target = this.chatTarget();
    const body: Record<string, unknown> = {
      model: target.model,
      messages,
      stream: false,
      max_tokens: opts.maxTokens ?? 8192,
      temperature: opts.temperature ?? 0.7,
    };
    if (opts.tools?.length) body["tools"] = opts.tools;

    let res = await fetch(target.url, {
      method: "POST",
      headers: target.headers,
      body: JSON.stringify(body),
    });

    // 401 auto-recovery is a Klaatu-auth flow — custom endpoints get no retry.
    if (res.status === 401 && !this._custom && await this.tryRecoverAuth()) {
      res = await fetch(target.url, {
        method: "POST",
        headers: this.headers(),
        body: JSON.stringify(body),
      });
    }

    if (!res.ok) {
      const text = await res.text().catch(() => "");
      throw new Error(sanitizeError(text, res.status));
    }

    return res.json() as Promise<ChatResponse>;
  }

  /**
   * Streaming chat completion — yields StreamChunks.
   *
   * Parses SSE (text/event-stream) format:
   *   data: {...json...}
   *   data: [DONE]
   */
  async *chatStream(
    messages: Message[],
    opts: {
      tools?: ToolDefinition[];
      maxTokens?: number;
      temperature?: number;
      /** Force a specific routing tier (nano/fast/code/reason/heavy). */
      tier?: string;
      /** Task-shape hint (D4): plan|edit|search|summarize. */
      task?: "plan" | "edit" | "search" | "summarize";
    } = {}
  ): AsyncGenerator<StreamChunk> {
    const reqHeaders: Record<string, string> = {};
    if (opts.task) reqHeaders["X-KlaatAI-Task"] = opts.task;
    const fbHeader = this.takeFeedbackHeader();
    if (fbHeader) reqHeaders["X-KlaatAI-Model-Feedback"] = fbHeader;

    const target = this.chatTarget(reqHeaders);
    const body: Record<string, unknown> = {
      // Tier aliases are a Klaatu routing protocol — meaningless to custom endpoints.
      model: this._custom ? target.model
        : opts.tier ? (TIER_MODEL_ALIAS[opts.tier] ?? this.model) : this.model,
      messages,
      stream: true,
      max_tokens: opts.maxTokens ?? 8192,
      temperature: opts.temperature ?? 0.7,
    };
    if (opts.tools?.length) body["tools"] = opts.tools;

    let res = await fetch(target.url, {
      method: "POST",
      headers: target.headers,
      body: JSON.stringify(body),
    });

    // 401 auto-recovery is a Klaatu-auth flow — custom endpoints get no retry.
    if (res.status === 401 && !this._custom && await this.tryRecoverAuth()) {
      res = await fetch(target.url, {
        method: "POST",
        headers: this.headers(reqHeaders),
        body: JSON.stringify(body),
      });
    }

    // Honor the server retry contract (D6): X-KlaatAI-Retry "no" = the cascade
    // already exhausted its failovers, never client-retry; "after-<s>" = one
    // scheduled retry. Waits over 60s (e.g. daily-quota Retry-After pointing at
    // midnight UTC) are not slept on — surface the error instead.
    if (!res.ok && !this._custom) {
      const waitMs = KlaatAIClient.retryDelayMs(res.headers, res.status);
      if (waitMs !== null && waitMs <= 60_000) {
        await new Promise(r => setTimeout(r, waitMs));
        res = await fetch(target.url, {
          method: "POST",
          headers: this.headers(reqHeaders),
          body: JSON.stringify(body),
        });
      }
    }

    if (!res.ok) {
      const text = await res.text().catch(() => "");
      yield { type: "error", error: sanitizeError(text, res.status) };
      return;
    }

    // Surface the weighted-unit quota (E1) + authoritative tier from response
    // headers before streaming the body. Only emitted when the server sends them.
    const quota = KlaatAIClient.parseQuotaHeaders(res.headers);
    if (quota) yield { type: "quota", quota };

    if (!res.body) {
      yield { type: "error", error: "No response body" };
      return;
    }

    const reader = res.body.getReader();
    const decoder = new TextDecoder();
    let buffer = "";

    // Accumulate tool-call fragments by index. Works for BOTH:
    //  - one delta carrying a complete tool call (Klaatu today), and
    //  - OpenAI-style fragmented deltas (id+name first, arguments streamed).
    // Flushed as complete ToolCall[] at finish_reason / [DONE] / stream end.
    const toolAcc = new Map<number, { id: string; name: string; args: string }>();
    const flushToolCalls = (): ToolCall[] | null => {
      if (toolAcc.size === 0) return null;
      const calls = [...toolAcc.entries()]
        .sort((a, b) => a[0] - b[0])
        .map(([, t]) => ({
          id: t.id,
          type: "function" as const,
          function: { name: t.name, arguments: t.args },
        }));
      toolAcc.clear();
      return calls;
    };

    while (true) {
      const { done, value } = await reader.read();
      if (done) break;

      buffer += decoder.decode(value, { stream: true });
      const lines = buffer.split("\n");
      buffer = lines.pop() ?? "";

      for (const line of lines) {
        const trimmed = line.trim();
        if (!trimmed || !trimmed.startsWith("data: ")) continue;

        const data = trimmed.slice(6);
        if (data === "[DONE]") {
          const calls = flushToolCalls();
          if (calls) yield { type: "tool_call", tool_calls: calls };
          yield { type: "done" };
          return;
        }

        try {
          const chunk = JSON.parse(data);
          const choice = chunk.choices?.[0];
          if (!choice) continue;

          const delta = choice.delta;

          // Tool-call fragment(s): merge into the accumulator by index.
          if (delta?.tool_calls) {
            (delta.tool_calls as Record<string, unknown>[]).forEach((tc, pos) => {
              const idx = typeof tc.index === "number" ? tc.index : pos;
              const cur = toolAcc.get(idx) ?? { id: "", name: "", args: "" };
              if (tc.id) cur.id = tc.id as string;
              const fn = tc.function as { name?: string; arguments?: string } | undefined;
              if (fn?.name) cur.name = fn.name;
              if (fn?.arguments) cur.args += fn.arguments;
              toolAcc.set(idx, cur);
            });
          }

          // Text token
          if (delta?.content) {
            yield { type: "token", text: delta.content };
          }

          // Finish: emit assembled tool calls first, then usage/metadata.
          if (choice.finish_reason) {
            const calls = flushToolCalls();
            if (calls) yield { type: "tool_call", tool_calls: calls };
            if (chunk.usage) {
              yield { type: "metadata", usage: chunk.usage, metadata: chunk.x_klaatai };
            }
          }
        } catch {
          // Malformed chunk — skip silently
        }
      }
    }

    // Stream ended without [DONE]/finish_reason — flush any pending tool calls.
    const tail = flushToolCalls();
    if (tail) yield { type: "tool_call", tool_calls: tail };
  }

  /**
   * Server retry contract → delay in ms for ONE scheduled client retry, or
   * null for "do not retry". `X-KlaatAI-Retry: no` always wins (cascade
   * exhausted); `after-<s>` schedules; bare 429s fall back to `Retry-After`.
   */
  static retryDelayMs(h: Headers, status: number): number | null {
    const hint = h.get("X-KlaatAI-Retry");
    if (hint === "no") return null;
    const m = hint?.match(/^after-(\d+(?:\.\d+)?)$/);
    if (m) return Math.round(Number(m[1]) * 1000);
    if (status === 429) {
      const ra = Number(h.get("Retry-After"));
      if (Number.isFinite(ra) && ra > 0) return Math.round(ra * 1000);
    }
    return null;
  }

  /**
   * Parse the E1 weighted-unit quota + tier from response headers. Returns null
   * when none are present (older server / non-subscription auth). Tolerant of a
   * missing subset — populates only the fields the server actually sent.
   */
  static parseQuotaHeaders(h: Headers): QuotaSnapshot | null {
    const num = (v: string | null): number | undefined => {
      if (v == null) return undefined;
      const n = Number(v);
      return Number.isFinite(n) ? n : undefined;
    };
    const q: QuotaSnapshot = {
      unitsUsed:     num(h.get("X-KlaatAI-Units-Used")),
      unitsLimit:    num(h.get("X-KlaatAI-Units-Limit")),
      requestsUsed:  num(h.get("X-KlaatAI-Quota-Used")),
      requestsLimit: num(h.get("X-KlaatAI-Quota-Limit")),
      // Server sends the plan as X-KlaatAI-Quota-Plan (accept legacy -Plan too).
      plan:          h.get("X-KlaatAI-Quota-Plan") ?? h.get("X-KlaatAI-Plan") ?? undefined,
      tier:          h.get("X-KlaatAI-Tier") ?? undefined,
      streamMode:    h.get("X-KlaatAI-Stream-Mode") ?? undefined,
      loopSignal:    h.get("X-KlaatAI-Loop-Signal") ?? undefined,
    };
    const has = Object.values(q).some(v => v !== undefined);
    return has ? q : null;
  }

  /** Estimate USD cost from metadata (client-side display only). */
  static formatCost(metadata?: KlaatAIMetadata, usage?: { prompt_tokens: number; completion_tokens: number }): string {
    if (!metadata || !usage) return "";
    // Simple tier-based estimate matching server _USER_COST_PER_MT
    const tierCosts: Record<string, [number, number]> = {
      nano:   [0.10, 0.20],
      fast:   [0.25, 0.75],
      code:   [0.50, 1.50],
      reason: [1.00, 3.00],
      heavy:  [2.50, 8.00],
      flash:  [0.25, 0.75],
      core:   [0.60, 2.00],
      beast:  [2.50, 8.00],
    };
    const [inp, out] = tierCosts[metadata.tier] ?? [0.5, 1.5];
    const cost = (usage.prompt_tokens * inp + usage.completion_tokens * out) / 1_000_000;
    return cost < 0.001 ? "<$0.001" : `$${cost.toFixed(4)}`;
  }
}
