/**
 * KlaatTUI — Cell buffer with dirty-diff rendering.
 *
 * The engine maintains two cell grids:
 *   back  — what we WANT on screen (written by render functions)
 *   front — what IS currently on screen
 *
 * flush() diffs them, emits the minimal ANSI to stdout to reconcile,
 * then swaps back → front.
 *
 * Design decisions:
 *   - Wide characters (CJK, emoji) occupy 2 columns; the second
 *     column is stored as a zero-width placeholder cell.
 *   - Style resets are issued per-run, not per-cell, to minimise bytes.
 *   - Cursor positioning is deferred until after flush() so the
 *     visible cursor stays on the input caret.
 */

import { moveTo, termWrite } from "./terminal.js";
import { type Color, fgCode, bgCode, ANSI_RESET, ANSI_BOLD, ANSI_DIM, ANSI_ITALIC, ANSI_UNDERLINE } from "./color.js";
import { charWidth } from "./input.js";

// ─── Style + Cell ─────────────────────────────────────────────────────────────

export interface Style {
  fg?:        Color;
  bg?:        Color;
  bold?:      boolean;
  dim?:       boolean;
  italic?:    boolean;
  underline?: boolean;
}

export interface Cell {
  char:      string;   // grapheme (may be empty for wide-char placeholders)
  fg:        Color;
  bg:        Color;
  bold:      boolean;
  dim:       boolean;
  italic:    boolean;
  underline: boolean;
  wide:      boolean;  // true = this cell is the left half of a wide char
}

const EMPTY: Cell = {
  char: " ", fg: null, bg: null,
  bold: false, dim: false, italic: false, underline: false, wide: false,
};

function cellEq(a: Cell, b: Cell): boolean {
  return (
    a.char      === b.char &&
    a.fg        === b.fg   &&
    a.bg        === b.bg   &&
    a.bold      === b.bold &&
    a.dim       === b.dim  &&
    a.italic    === b.italic &&
    a.underline === b.underline &&
    a.wide      === b.wide
  );
}

function styleEq(a: Cell, b: Cell): boolean {
  return (
    a.fg        === b.fg   &&
    a.bg        === b.bg   &&
    a.bold      === b.bold &&
    a.dim       === b.dim  &&
    a.italic    === b.italic &&
    a.underline === b.underline
  );
}

function emitStyle(cell: Cell): string {
  let s = ANSI_RESET;
  if (cell.fg !== null)  s += fgCode(cell.fg);
  if (cell.bg !== null)  s += bgCode(cell.bg);
  if (cell.bold)         s += ANSI_BOLD;
  if (cell.dim)          s += ANSI_DIM;
  if (cell.italic)       s += ANSI_ITALIC;
  if (cell.underline)    s += ANSI_UNDERLINE;
  return s;
}

// ─── CellBuffer ───────────────────────────────────────────────────────────────

export class CellBuffer {
  private _cols:  number;
  private _rows:  number;
  private _front: Cell[];
  private _back:  Cell[];
  private _dirty: boolean[];

  /** Optional cursor position to move to after flush (null = hidden). */
  cursorTarget: { row: number; col: number } | null = null;

  constructor(cols: number, rows: number) {
    this._cols = cols;
    this._rows = rows;
    const size = cols * rows;
    this._front = Array.from({ length: size }, () => ({ ...EMPTY }));
    this._back  = Array.from({ length: size }, () => ({ ...EMPTY }));
    this._dirty = new Array<boolean>(size).fill(true); // first frame = full redraw
  }

  get cols(): number { return this._cols; }
  get rows(): number { return this._rows; }

  // ─── Resize ──────────────────────────────────────────────────────────

  resize(cols: number, rows: number): void {
    this._cols = cols;
    this._rows = rows;
    const size = cols * rows;
    this._front = Array.from({ length: size }, () => ({ ...EMPTY }));
    this._back  = Array.from({ length: size }, () => ({ ...EMPTY }));
    this._dirty = new Array<boolean>(size).fill(true);
    this.cursorTarget = null;
  }

  // ─── Back-buffer writes ───────────────────────────────────────────────

  /** Set a single cell in the back buffer. Out-of-bounds writes are silently ignored. */
  set(row: number, col: number, char: string, style: Style = {}): void {
    if (row < 0 || row >= this._rows || col < 0 || col >= this._cols) return;
    const i = row * this._cols + col;
    const c = this._back[i]!;
    // Wide glyphs paint atomically: the terminal clobbers BOTH columns when
    // either is overwritten. Overwriting half of a pair must therefore blank
    // the partner cell too, or the diff believes the partner is still on
    // screen and skips it — text stays visibly stuck until that exact cell
    // happens to change (the "stale fragments after CJK output" corruption).
    if (c.wide && col > 0) {
      // c was a placeholder — blank the glyph to its left.
      const g = this._back[i - 1]!;
      if (g.char !== EMPTY.char || g.wide) { Object.assign(g, EMPTY); this._dirty[i - 1] = true; }
    } else if (col + 1 < this._cols && this._back[i + 1]!.wide) {
      // c was a glyph — blank its placeholder to the right.
      Object.assign(this._back[i + 1]!, EMPTY);
      this._dirty[i + 1] = true;
    }
    c.char      = char;
    c.fg        = style.fg        ?? null;
    c.bg        = style.bg        ?? null;
    c.bold      = style.bold      ?? false;
    c.dim       = style.dim       ?? false;
    c.italic    = style.italic    ?? false;
    c.underline = style.underline ?? false;
    c.wide      = false;
    this._dirty[i] = true;
  }

  /**
   * Write a string starting at (row, col), clipping to buffer bounds.
   * Wide (2-column) characters advance col by 2 and fill the next cell
   * with a placeholder so the diff never writes garbage there.
   */
  write(row: number, col: number, text: string, style: Style = {}): void {
    let c = col;
    for (const char of text) {
      if (c >= this._cols) break;
      const w = charWidth(char);
      if (w === 0) continue; // skip zero-width

      this.set(row, c, char, style);

      if (w === 2) {
        // Mark next cell as wide-char placeholder
        if (c + 1 < this._cols) {
          const i = row * this._cols + (c + 1);
          const ph = this._back[i]!;
          // If this cell was itself a glyph, its old placeholder at c+2 is
          // now orphaned — blank it (same pair-breaking rule as set()).
          if (!ph.wide && c + 2 < this._cols && this._back[i + 1]!.wide) {
            Object.assign(this._back[i + 1]!, EMPTY);
            this._dirty[i + 1] = true;
          }
          ph.char      = "";
          ph.fg        = style.fg        ?? null;
          ph.bg        = style.bg        ?? null;
          ph.bold      = style.bold      ?? false;
          ph.dim       = style.dim       ?? false;
          ph.italic    = style.italic    ?? false;
          ph.underline = style.underline ?? false;
          ph.wide      = true;
          this._dirty[i] = true;
        }
      }
      c += w;
    }
  }

  /** Fill a rectangular region with a repeated character. */
  fill(
    row: number, col: number,
    height: number, width: number,
    char: string, style: Style = {}
  ): void {
    for (let r = row; r < row + height && r < this._rows; r++) {
      for (let c = col; c < col + width && c < this._cols; c++) {
        this.set(r, c, char, style);
      }
    }
  }

  /** Clear the back buffer to blank cells (call once per render cycle). */
  clear(style: Style = {}): void {
    const blank: Cell = {
      char: " ",
      fg:        style.fg        ?? null,
      bg:        style.bg        ?? null,
      bold:      style.bold      ?? false,
      dim:       style.dim       ?? false,
      italic:    style.italic    ?? false,
      underline: style.underline ?? false,
      wide:      false,
    };
    for (let i = 0; i < this._back.length; i++) {
      if (!cellEq(this._back[i]!, blank)) {
        Object.assign(this._back[i]!, blank);
        this._dirty[i] = true;
      }
    }
  }

  // ─── Flush ────────────────────────────────────────────────────────────

  /**
   * Inline flush — used by App.runInline().
   *
   * Moves the terminal cursor up `liveRows` lines (from the bottom of the
   * live area), then clears and redraws each row.  Does not diff — always
   * redraws all rows (the live area is intentionally small, so this is fast).
   */
  flushInline(liveRows: number): void {
    const rows = Math.min(liveRows, this._rows);
    let out = "";

    // Move to the first row of the live area (up N rows, carriage return)
    if (rows > 0) out += `\x1b[${rows}A\r`;

    for (let r = 0; r < rows; r++) {
      out += "\x1b[2K"; // erase entire line

      let prevStyle: Cell | null = null;
      for (let c = 0; c < this._cols; c++) {
        const i = r * this._cols + c;
        const back = this._back[i]!;

        if (!prevStyle || !styleEq(back, prevStyle)) {
          out += emitStyle(back);
          prevStyle = back;
        }

        out += back.wide ? " " : (back.char || " ");

        // Sync front buffer
        Object.assign(this._front[i]!, back);
        this._dirty[i] = false;
      }

      // Advance to next row (not needed after the last row)
      if (r < rows - 1) out += "\r\n";
    }

    out += ANSI_RESET;

    // Position cursor at input caret (cursorTarget is in live-area coordinates)
    if (this.cursorTarget) {
      const { row, col } = this.cursorTarget;
      const upFromBottom = rows - 1 - row;
      if (upFromBottom > 0) out += `\x1b[${upFromBottom}A`;
      out += "\r";
      if (col > 0) out += `\x1b[${col}C`;
      this.cursorTarget = null;
    }

    if (out.length > 0) termWrite(out);
  }

  /**
   * Diff front vs back, write minimal ANSI to stdout, then sync front ← back.
   *
   * Optimisations:
   *   - Skips cells where front === back (and dirty flag is false)
   *   - Skips the moveTo() call when the cursor is already in position
   *   - Groups style with subsequent chars on the same row
   */
  flush(): void {
    let out = "";
    let curRow = -1;
    let curCol = -1;
    let prevStyle: Cell | null = null;
    // Set after printing a width-2 char: the following placeholder cell is
    // already covered by the glyph. Printing a space there (the old
    // behaviour) overwrote the glyph's right half, which makes terminals
    // blank the whole glyph — and desyncs the cursor besides.
    let skipPlaceholder = false;

    for (let r = 0; r < this._rows; r++) {
      for (let c = 0; c < this._cols; c++) {
        const i = r * this._cols + c;
        const back  = this._back[i]!;
        const front = this._front[i]!;

        if (skipPlaceholder) {
          skipPlaceholder = false;
          if (back.wide) {
            // Glyph to the left just painted both columns — only bookkeep.
            Object.assign(front, back);
            this._dirty[i] = false;
            continue;
          }
        }

        // Skip unchanged cells. Equality alone decides: `dirty` only means
        // "written this frame", and write() marks cells dirty even when the
        // value didn't change — the old `!dirty &&` guard made every frame
        // re-emit every cell the render touched, which during streaming is
        // most of the screen (bytes → flicker on slow terminals).
        if (cellEq(back, front)) {
          this._dirty[i] = false;
          continue;
        }

        // Position cursor
        const needMove = r !== curRow || c !== curCol;
        if (needMove) {
          out += moveTo(r, c);
          curRow = r;
          curCol = c;
        }

        // Style (emit if changed vs previous cell written this frame)
        if (!prevStyle || !styleEq(back, prevStyle)) {
          out += emitStyle(back);
          prevStyle = back;
        }

        // Character (wide-char placeholder emits a space)
        out += back.wide ? " " : (back.char || " ");

        // Advance virtual cursor
        const w = back.wide ? 1 : (charWidth(back.char) || 1);
        curCol += w;
        if (w === 2) skipPlaceholder = true;

        // The virtual cursor is only trustworthy for printable ASCII — for
        // anything else the terminal's actual advance can differ from
        // charWidth() (ambiguous-width symbols, emoji presentation, font
        // quirks). Trusting it lets the diff skip moveTo() and paint every
        // later run in the row at an offset — the classic "SesSession"
        // doubled-prefix corruption. Force a re-position instead.
        const cp = back.wide ? 0 : (back.char.codePointAt(0) ?? 0);
        if (cp > 0x7e) curCol = -0x7fffffff;

        // Sync front buffer
        Object.assign(front, back);
        this._dirty[i] = false;
      }
      skipPlaceholder = false;
    }

    // Reset style at end of frame
    if (out.length > 0) {
      out += ANSI_RESET;
    }

    // Move cursor to caret position (visible cursor for input field)
    if (this.cursorTarget) {
      out += moveTo(this.cursorTarget.row, this.cursorTarget.col);
      this.cursorTarget = null;
    }

    // Synchronized update (DEC 2026): the terminal applies the whole frame
    // atomically instead of repainting mid-write — kills streaming-time
    // tearing. Ignored by terminals that don't support it.
    if (out.length > 0) {
      termWrite(`\x1b[?2026h${out}\x1b[?2026l`);
    }
  }

  /** Forget everything the screen is believed to contain — the next flush
   *  repaints every cell. Recovery path for external corruption (a stray
   *  dependency console.log, a terminal glitch): wired to Ctrl+L. */
  invalidate(): void {
    for (const cell of this._front) Object.assign(cell, EMPTY);
    this._dirty.fill(true);
  }
}
