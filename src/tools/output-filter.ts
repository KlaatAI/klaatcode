/**
 * Tool-output noise filter (roadmap 9.1).
 *
 * 60–75% of command-output tokens are noise the model pays for on every
 * subsequent request: progress bars redrawn hundreds of times, spinner
 * frames, passing-test spam, identical repeated lines. This filter runs on
 * run_command / shell_output results BEFORE they enter the context:
 *
 *   - carriage-return overwrites: keep only the final state of each line;
 *   - ANSI escape sequences stripped;
 *   - consecutive progress-bar/spinner lines collapsed to their last frame;
 *   - runs of passing-test lines collapsed to a count (failures kept full);
 *   - consecutive identical lines deduped past a threshold.
 *
 * Contract: exit codes, stderr markers, failure detail, and summary lines are
 * never removed. Fail-open — any internal error returns the raw output. If
 * filtering saves <8% of chars the raw output is returned unchanged (a marker
 * line would cost more than it saves).
 */

let filterEnabled = true;

/** Config gate (config.json `outputFilter: "off"`). */
export function setOutputFilterEnabled(on: boolean): void {
  filterEnabled = on;
}

// ─── Line classifiers ────────────────────────────────────────────────────────

// eslint-disable-next-line no-control-regex
const ANSI_RE = /\x1b\[[0-9;?]*[ -\/]*[@-~]|\x1b\][^\x07\x1b]*(?:\x07|\x1b\\)/g;

/** Progress bars, spinners, percent tickers — noise except the final frame. */
const PROGRESS_RES: RegExp[] = [
  /[█▓▒░▏▎▍▌▋▊▉━]{4,}/,                        // block/heavy bars (pip, uv, docker)
  /\[[=\-#>. ]{4,}\]\s*\d{0,3}/,                 // [====>   ] 42%  (npm, wget)
  /(^|\s)\d{1,3}(\.\d+)?%\s*[|(\[]/,             // 42%|████  / 42% (…)
  /^[\s]*[⠁-⣿][\s]/,                             // braille spinner frames
  /^[|/\\-]\s/,                                  // ascii spinner frames
  /(Receiving|Resolving|Compressing|Counting) (objects|deltas):\s+\d{1,3}%/, // git
  /^\s*(Downloading|Uploading|Fetching|Pulling|Extracting)\b.*\d{1,3}(\.\d+)?\s*%/i,
  /^\s*(⠴|⠦|⠇|⠋|⠙|⠸)?\s*idealTree|reify:/,       // npm install ticker
];

/** A line that is PURELY a passing-test report (safe to count instead of keep). */
const PASS_RES: RegExp[] = [
  /^\s*(✓|✔|√|·)\s/,                             // jest/bun/vitest pass glyphs
  /^\s*\(pass\)\s/,                              // bun test
  /\bPASSED\b(?!.*\b(FAIL|ERROR)\b)/,            // pytest verbose
  /^\s*--- PASS:/,                               // go test -v
  /^\s*=== RUN\b/,                               // go test -v run markers
  /^test .* \.\.\. ok$/,                         // cargo test
  /^\s*ok\s+\d+\b/,                              // TAP
];

/** Failure signal — lines matching these (or near them) are NEVER collapsed. */
const FAIL_RE = /\b(FAIL(ED|URE)?|ERROR|✗|✘|×|panic|Traceback|AssertionError|Expected|not ok)\b/i;

/** Structural lines always kept: exit codes, stderr marker, summaries. */
const KEEP_RE = /^\[(exit \d+|stderr)\]|\b\d+ (passing|passed|failed|tests?|pass|fail|skipped)\b|\bTests:|\bTest Suites:|\bRan \d+ tests?\b/i;

function isProgress(line: string): boolean {
  return PROGRESS_RES.some(re => re.test(line));
}

function isPass(line: string): boolean {
  if (FAIL_RE.test(line) || KEEP_RE.test(line)) return false;
  return PASS_RES.some(re => re.test(line));
}

// ─── Filter passes ───────────────────────────────────────────────────────────

/** Keep only the final state of \r-overwritten segments within each line. */
function resolveCarriageReturns(raw: string): string {
  if (!raw.includes("\r")) return raw;
  return raw
    .split("\n")
    .map(line => {
      if (!line.includes("\r")) return line;
      const parts = line.split("\r");
      // The last non-empty segment is what the terminal would show.
      for (let i = parts.length - 1; i >= 0; i--) {
        if (parts[i]!.trim() !== "") return parts[i]!;
      }
      return parts[parts.length - 1]!;
    })
    .join("\n");
}

const DUP_THRESHOLD = 3;   // ≥ N consecutive identical lines → dedupe
const PASS_RUN_MIN  = 5;   // ≥ N consecutive passing-test lines → collapse

interface PassCounts { progress: number; dupes: number; passes: number }

function filterLines(lines: string[], counts: PassCounts): string[] {
  const out: string[] = [];
  let i = 0;
  while (i < lines.length) {
    const line = lines[i]!;

    // Progress run → keep only the last frame.
    if (isProgress(line) && !FAIL_RE.test(line) && !KEEP_RE.test(line)) {
      let j = i;
      while (j + 1 < lines.length && isProgress(lines[j + 1]!) &&
             !FAIL_RE.test(lines[j + 1]!) && !KEEP_RE.test(lines[j + 1]!)) j++;
      out.push(lines[j]!);          // final frame carries the end state
      counts.progress += j - i;     // frames dropped
      i = j + 1;
      continue;
    }

    // Passing-test run → collapse to a count.
    if (isPass(line)) {
      let j = i;
      while (j + 1 < lines.length && isPass(lines[j + 1]!)) j++;
      const runLen = j - i + 1;
      if (runLen >= PASS_RUN_MIN) {
        out.push(`[✓ ${runLen} passing tests — collapsed]`);
        counts.passes += runLen;
        i = j + 1;
        continue;
      }
      // Short run: keep as-is (fall through one line at a time).
    }

    // Consecutive identical lines → dedupe.
    let j = i;
    while (j + 1 < lines.length && lines[j + 1] === line && line.trim() !== "") j++;
    const repeats = j - i + 1;
    if (repeats >= DUP_THRESHOLD) {
      out.push(line, `[… previous line repeated ${repeats - 1} more times]`);
      counts.dupes += repeats - 1;
      i = j + 1;
      continue;
    }

    out.push(line);
    i++;
  }
  return out;
}

// ─── Entry point ─────────────────────────────────────────────────────────────

const MIN_SAVINGS_RATIO = 0.08; // don't bother below 8% saved

/**
 * Filter noisy command output before it enters model context.
 * Returns the raw string untouched when disabled, on error, or when the
 * savings are too small to justify the marker lines.
 */
export function filterCommandOutput(raw: string): string {
  if (!filterEnabled || !raw || raw.length < 400) return raw;
  try {
    const counts: PassCounts = { progress: 0, dupes: 0, passes: 0 };
    let text = resolveCarriageReturns(raw);
    text = text.replace(ANSI_RE, "");
    const filtered = filterLines(text.split("\n"), counts).join("\n");

    const removed = counts.progress + counts.dupes + counts.passes;
    if (removed === 0) return text === raw ? raw : text; // ANSI/\r cleanup is free
    if (raw.length - filtered.length < raw.length * MIN_SAVINGS_RATIO) return text;

    const parts: string[] = [];
    if (counts.progress) parts.push(`${counts.progress} progress frames`);
    if (counts.passes)   parts.push(`${counts.passes} passing-test lines`);
    if (counts.dupes)    parts.push(`${counts.dupes} duplicate lines`);
    return filtered +
      `\n[output filter: collapsed ${parts.join(", ")} — failures and summaries kept in full]`;
  } catch {
    return raw; // fail-open: never lose output to the filter itself
  }
}
