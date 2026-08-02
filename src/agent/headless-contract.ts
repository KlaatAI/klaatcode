/**
 * Headless exec contract — the machine-facing surface of `klaatai run`.
 *
 * Turns an agent run into something a script/CI can drive reliably:
 *   - JSONL event stream (--json): one JSON object per line
 *   - structured final answer validated against a JSON Schema (--output-schema)
 *   - deterministic exit codes
 *
 * All pure and dependency-free (a minimal JSON-Schema subset validator) so it
 * unit-tests cleanly and adds no supply-chain surface to a CI install.
 */

/** Deterministic exit codes — a script can branch on these. */
export const EXIT = {
  OK: 0,             // task completed
  GENERIC: 1,        // auth / usage / unexpected error
  TASK_FAILED: 2,    // agent stopped without success (loop, max_turns, bad schema)
  COST_CAP: 3,       // --max-cost reached
  NEEDS_APPROVAL: 4, // a tool needed approval that headless can't grant
} as const;

export type HeadlessEvent =
  | { type: "start"; prompt: string; tier?: string; tools: number }
  | { type: "tool"; name: string; detail?: string }
  | { type: "turn"; n: number }
  | { type: "cost"; usd: number; tokens: { prompt: number; completion: number } }
  | { type: "result"; ok: boolean; text?: string; data?: unknown; stoppedBy: string; cost: number; error?: string };

/** Serialize one event as a single JSONL line (newline included). */
export function encodeEvent(ev: HeadlessEvent): string {
  return JSON.stringify(ev) + "\n";
}

// ─── Minimal JSON Schema validation (subset) ──────────────────────────────────

export interface JsonSchema {
  type?: "object" | "array" | "string" | "number" | "integer" | "boolean" | "null";
  properties?: Record<string, JsonSchema>;
  required?: string[];
  items?: JsonSchema;
  enum?: unknown[];
}

/** Validate `value` against a schema subset. Returns a list of error strings (empty = valid). */
export function validateSchema(value: unknown, schema: JsonSchema, path = "$"): string[] {
  const errs: string[] = [];
  if (schema.enum && !schema.enum.some(e => e === value)) {
    errs.push(`${path}: value not in enum [${schema.enum.map(String).join(", ")}]`);
    return errs;
  }
  const t = schema.type;
  if (t) {
    const ok =
      t === "object" ? value !== null && typeof value === "object" && !Array.isArray(value) :
      t === "array" ? Array.isArray(value) :
      t === "integer" ? typeof value === "number" && Number.isInteger(value) :
      t === "null" ? value === null :
      typeof value === t;
    if (!ok) { errs.push(`${path}: expected ${t}, got ${Array.isArray(value) ? "array" : value === null ? "null" : typeof value}`); return errs; }
  }
  if (schema.type === "object" && value && typeof value === "object") {
    const obj = value as Record<string, unknown>;
    for (const key of schema.required ?? []) {
      if (!(key in obj)) errs.push(`${path}.${key}: required property missing`);
    }
    for (const [key, sub] of Object.entries(schema.properties ?? {})) {
      if (key in obj) errs.push(...validateSchema(obj[key], sub, `${path}.${key}`));
    }
  }
  if (schema.type === "array" && Array.isArray(value) && schema.items) {
    value.forEach((item, i) => errs.push(...validateSchema(item, schema.items!, `${path}[${i}]`)));
  }
  return errs;
}

/**
 * Pull a JSON object/array out of a model's final answer: prefer a fenced
 * ```json block, else the first balanced {...} or [...] span, else the whole
 * trimmed text. Returns the parsed value or null if nothing parses.
 */
export function extractJson(text: string): unknown | null {
  const fence = /```(?:json)?\s*([\s\S]*?)```/i.exec(text);
  const candidates: string[] = [];
  if (fence?.[1]) candidates.push(fence[1].trim());
  const span = firstBalancedSpan(text);
  if (span) candidates.push(span);
  candidates.push(text.trim());
  for (const c of candidates) {
    try { return JSON.parse(c); } catch { /* next */ }
  }
  return null;
}

/** First balanced {...} or [...] span in the text (brace-matched, quote-aware). */
function firstBalancedSpan(text: string): string | null {
  const open = /[{[]/.exec(text);
  if (!open) return null;
  const start = open.index;
  const openCh = text[start]!;
  const closeCh = openCh === "{" ? "}" : "]";
  let depth = 0, inStr: '"' | "'" | null = null, esc = false;
  for (let i = start; i < text.length; i++) {
    const c = text[i]!;
    if (inStr) {
      if (esc) esc = false;
      else if (c === "\\") esc = true;
      else if (c === inStr) inStr = null;
      continue;
    }
    if (c === '"' || c === "'") inStr = c;
    else if (c === openCh) depth++;
    else if (c === closeCh) { depth--; if (depth === 0) return text.slice(start, i + 1); }
  }
  return null;
}

/** Instruction appended to the prompt so the model emits schema-conforming JSON. */
export function schemaInstruction(schema: JsonSchema): string {
  return (
    "\n\nIMPORTANT: When the task is complete, your FINAL message must be a single JSON " +
    "value that conforms to this JSON Schema, and nothing else (no prose, no code fence):\n" +
    JSON.stringify(schema)
  );
}
