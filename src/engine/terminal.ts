/**
 * KlaatTUI — Low-level terminal I/O.
 *
 * Wraps:
 *   - Alternate screen buffer (enter/exit)
 *   - Raw mode stdin
 *   - Cursor control
 *   - Terminal size + SIGWINCH
 *   - Batched stdout writes
 */

const ESC = "\x1b";

// ─── Alternate screen ─────────────────────────────────────────────────────────

export function enterAltScreen(): void {
  process.stdout.write(`${ESC}[?1049h`);
}

export function exitAltScreen(): void {
  process.stdout.write(`${ESC}[?1049l`);
}

// ─── Cursor ───────────────────────────────────────────────────────────────────

export function hideCursor(): void {
  process.stdout.write(`${ESC}[?25l`);
}

export function showCursor(): void {
  process.stdout.write(`${ESC}[?25h`);
}

/**
 * ANSI cursor-move sequence (0-indexed row/col → 1-indexed terminal coords).
 * Returns the escape string rather than writing it, so callers can batch.
 */
export function moveTo(row: number, col: number): string {
  return `${ESC}[${row + 1};${col + 1}H`;
}

// ─── Screen clear ─────────────────────────────────────────────────────────────

export function clearScreen(): void {
  process.stdout.write(`${ESC}[2J${ESC}[H`);
}

/** Returns the ANSI sequence to erase the current line (for batching). */
export function eraseLine(): string {
  return `${ESC}[2K`;
}

// ─── Autowrap (DECAWM) ────────────────────────────────────────────────────────
// Full-screen TUI must run with autowrap OFF: painting the bottom-right cell
// otherwise arms "pending wrap", and the next byte anyone writes (a stray
// console.log from a dependency is enough) scrolls the whole alt screen one
// line — the front buffer is then wrong for EVERY row and the UI shows
// stacked stale lines until the next full clear. Wrap-off also turns any
// char-width miscount at a row edge into a clipped glyph instead of a wrap.

export function disableAutowrap(): void {
  process.stdout.write(`${ESC}[?7l`);
}

export function enableAutowrap(): void {
  process.stdout.write(`${ESC}[?7h`);
}

// ─── Mouse support ────────────────────────────────────────────────────────────

export function enableMouse(): void {
  // ?1000h = button press/release, ?1002h = drag (motion while button held), ?1006h = SGR extended coords
  process.stdout.write(`${ESC}[?1000h${ESC}[?1002h${ESC}[?1006h`);
}

export function disableMouse(): void {
  process.stdout.write(`${ESC}[?1006l${ESC}[?1002l${ESC}[?1000l`);
}

// ─── Bracketed paste mode ─────────────────────────────────────────────────────
// https://invisible-island.net/xterm/ctlseqs/ctlseqs.html#h2-Bracketed-Paste-Mode
//
// When enabled, pasted text is wrapped in \x1b[200~ ... \x1b[201~ so the
// InputParser can distinguish paste from typed input.

export function enableBracketedPaste(): void {
  process.stdout.write(`${ESC}[?2004h`);
}

export function disableBracketedPaste(): void {
  process.stdout.write(`${ESC}[?2004l`);
}

// ─── Kitty keyboard protocol ──────────────────────────────────────────────────
// https://sw.kovidgoyal.net/kitty/keyboard-protocol/
//
// Flag 1 = Disambiguate escape codes:
//   Ctrl+I ≠ Tab, Ctrl+M ≠ Enter, Ctrl+[ ≠ Escape, Shift+Enter distinct, etc.
//   All modifiers are unambiguous. Falls back silently on unsupporting terminals.

export function enableKitty(): void {
  // Push progressive enhancement flags=1 (disambiguate) onto terminal's stack
  process.stdout.write(`${ESC}[>1u`);
}

export function disableKitty(): void {
  // Pop back to previous keyboard mode
  process.stdout.write(`${ESC}[<u`);
}

// ─── Raw mode ─────────────────────────────────────────────────────────────────

export function setRawMode(raw: boolean): void {
  if (process.stdin.isTTY) {
    process.stdin.setRawMode(raw);
  }
}

// ─── Terminal size ────────────────────────────────────────────────────────────

export interface TermSize {
  cols: number;
  rows: number;
}

export function termSize(): TermSize {
  return {
    cols: process.stdout.columns ?? 80,
    rows: process.stdout.rows    ?? 24,
  };
}

// ─── Batched write ────────────────────────────────────────────────────────────

/** Write a string to stdout directly. Use CellBuffer.flush() for rendering. */
export function termWrite(s: string): void {
  if (s.length > 0) process.stdout.write(s);
}

// ─── Cleanup ─────────────────────────────────────────────────────────────────

/**
 * Restore the terminal to a sane state.
 * Safe to call multiple times.
 */
export function restoreTerminal(): void {
  showCursor();
  enableAutowrap();
  exitAltScreen();
  setRawMode(false);
}
