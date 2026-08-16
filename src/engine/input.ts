/**
 * KlaatTUI — Stdin raw-mode input parser.
 *
 * Reads raw bytes from stdin and emits structured KeyEvent objects.
 * Handles: ASCII, UTF-8 multibyte, ANSI escape sequences (arrows,
 * function keys, shift/ctrl/alt modifiers), bare ESC, and Alt+char.
 *
 * Usage:
 *   const parser = new InputParser();
 *   parser.on("key", (ev: KeyEvent) => { ... });
 *   parser.start();
 *   // later:
 *   parser.stop();
 */

import { EventEmitter } from "events";

// ─── Public types ─────────────────────────────────────────────────────────────

/**
 * SGR-extended mouse event (button press/release/wheel).
 * Emitted when the terminal reports a mouse action via \x1b[<...M/m.
 */
export interface MouseEvent {
  action:  "press" | "release" | "move";
  /** 0=left, 1=middle, 2=right, 64=wheel-up, 65=wheel-down */
  button:  number;
  x:       number;  // 0-indexed column
  y:       number;  // 0-indexed row
  ctrl:    boolean;
  alt:     boolean;
  shift:   boolean;
}

export interface KeyEvent {
  /** Logical key name, e.g. "a", "enter", "up", "ctrl+c", "f1", "alt+x".
   *  Mouse/wheel events use "wheel:up", "wheel:down", "mouse:press", "mouse:release".
   *  Paste events use "paste". */
  key: string;
  /** The printable character, if applicable (e.g. "a", "A", "€"). */
  char?: string;
  ctrl:  boolean;
  alt:   boolean;
  shift: boolean;
  /** Raw bytes that produced this event. */
  raw: Buffer;
  /** Set for mouse/wheel events; undefined for keyboard events. */
  mouse?: MouseEvent;
  /** Set for bracketed paste events; the full pasted text. */
  paste?: string;
}

// ─── ANSI escape sequence table ───────────────────────────────────────────────
// Sorted longest-first so we greedily match the most specific sequence.

const SEQUENCES: [string, string][] = [
  // Shift + arrows (xterm)
  ["\x1b[1;2A", "shift+up"],
  ["\x1b[1;2B", "shift+down"],
  ["\x1b[1;2C", "shift+right"],
  ["\x1b[1;2D", "shift+left"],
  // Alt + arrows
  ["\x1b[1;3A", "alt+up"],
  ["\x1b[1;3B", "alt+down"],
  ["\x1b[1;3C", "alt+right"],
  ["\x1b[1;3D", "alt+left"],
  // Ctrl + arrows
  ["\x1b[1;5A", "ctrl+up"],
  ["\x1b[1;5B", "ctrl+down"],
  ["\x1b[1;5C", "ctrl+right"],
  ["\x1b[1;5D", "ctrl+left"],
  // Ctrl+shift + arrows
  ["\x1b[1;6A", "ctrl+shift+up"],
  ["\x1b[1;6B", "ctrl+shift+down"],
  ["\x1b[1;6C", "ctrl+shift+right"],
  ["\x1b[1;6D", "ctrl+shift+left"],
  // Function keys F5-F12 (tilde form)
  ["\x1b[15~",  "f5"],
  ["\x1b[17~",  "f6"],
  ["\x1b[18~",  "f7"],
  ["\x1b[19~",  "f8"],
  ["\x1b[20~",  "f9"],
  ["\x1b[21~",  "f10"],
  ["\x1b[23~",  "f11"],
  ["\x1b[24~",  "f12"],
  // Standard arrow keys
  ["\x1b[A",    "up"],
  ["\x1b[B",    "down"],
  ["\x1b[C",    "right"],
  ["\x1b[D",    "left"],
  // Home / End (SS3 and CSI forms)
  ["\x1bOH",    "home"],
  ["\x1bOF",    "end"],
  ["\x1b[H",    "home"],
  ["\x1b[F",    "end"],
  ["\x1b[1~",   "home"],
  ["\x1b[4~",   "end"],
  // Page up/down
  ["\x1b[5~",   "pageup"],
  ["\x1b[6~",   "pagedown"],
  // Delete / Insert
  ["\x1b[3~",   "delete"],
  ["\x1b[2~",   "insert"],
  // Function keys F1-F4 (SS3 form)
  ["\x1bOP",    "f1"],
  ["\x1bOQ",    "f2"],
  ["\x1bOR",    "f3"],
  ["\x1bOS",    "f4"],
  // Function keys F1-F4 (CSI form, some terminals)
  ["\x1b[11~",  "f1"],
  ["\x1b[12~",  "f2"],
  ["\x1b[13~",  "f3"],
  ["\x1b[14~",  "f4"],
  // Shift+Tab (reverse tab, sent by most terminals as \x1b[Z)
  ["\x1b[Z",    "shift+tab"],
];

// Pre-sorted map (longest key first for greedy matching)
const SEQ_MAP = new Map<string, string>(
  SEQUENCES.sort((a, b) => b[0].length - a[0].length)
);

// ─── Ctrl-key byte → name ─────────────────────────────────────────────────────

const CTRL_BYTES: Record<number, string> = {
  1:  "ctrl+a",
  2:  "ctrl+b",
  3:  "ctrl+c",
  4:  "ctrl+d",
  5:  "ctrl+e",
  6:  "ctrl+f",
  7:  "ctrl+g",
  8:  "ctrl+h",   // often same as backspace
  9:  "tab",
  10: "ctrl+j",
  11: "ctrl+k",
  12: "ctrl+l",
  13: "enter",
  14: "ctrl+n",
  15: "ctrl+o",
  16: "ctrl+p",
  17: "ctrl+q",
  18: "ctrl+r",
  19: "ctrl+s",
  20: "ctrl+t",
  21: "ctrl+u",
  22: "ctrl+v",
  23: "ctrl+w",
  24: "ctrl+x",
  25: "ctrl+y",
  26: "ctrl+z",
  27: "escape",
  127: "backspace",
};

// ─── Kitty keyboard protocol codepoint → key name ─────────────────────────────
// Codepoints used for functional/nav keys in the CSI-u protocol.
// https://sw.kovidgoyal.net/kitty/keyboard-protocol/#functional-key-definitions

const KITTY_CP: Record<number, string> = {
  // ASCII control codes that need disambiguation under flags=1
  9:   "tab",
  13:  "enter",
  27:  "escape",
  127: "backspace",
  // Kitty private-use functional key codepoints (as sent when protocol active)
  // Arrow / nav keys
  57424: "up",     57425: "down",     57426: "right",    57427: "left",
  57428: "pageup", 57429: "pagedown", 57430: "home",     57431: "end",
  57432: "insert", 57433: "delete",
  // Function keys F1-F35 (Kitty assigns these starting at 57444)
  57444: "f1",  57445: "f2",  57446: "f3",  57447: "f4",
  57448: "f5",  57449: "f6",  57450: "f7",  57451: "f8",
  57452: "f9",  57453: "f10", 57454: "f11", 57455: "f12",
  57456: "f13", 57457: "f14", 57458: "f15", 57459: "f16",
  57460: "f17", 57461: "f18", 57462: "f19", 57463: "f20",
  // Numpad keys
  57399: "kp0", 57400: "kp1", 57401: "kp2", 57402: "kp3",
  57403: "kp4", 57404: "kp5", 57405: "kp6", 57406: "kp7",
  57407: "kp8", 57408: "kp9", 57409: "kp_decimal",
  57410: "kp_divide", 57411: "kp_multiply",
  57412: "kp_subtract", 57413: "kp_add", 57414: "kp_enter",
};



/**
 * Returns the number of terminal columns a Unicode codepoint occupies.
 * 2 for CJK / wide chars, 0 for combining / zero-width, 1 for everything else.
 */
export function charWidth(char: string): number {
  const cp = char.codePointAt(0) ?? 0;
  if (cp === 0) return 0;
  // Zero-width: combining, variation selectors, etc.
  if (
    (cp >= 0x0300 && cp <= 0x036F) ||
    (cp >= 0x200B && cp <= 0x200F) ||
    (cp >= 0xFE00 && cp <= 0xFE0F) ||
    cp === 0xFEFF
  ) return 0;
  // Wide (2-column) ranges
  if (
    (cp >= 0x1100 && cp <= 0x115F)   || // Hangul Jamo
    (cp >= 0x2E80 && cp <= 0x303E)   || // CJK Radicals
    (cp >= 0x3040 && cp <= 0x33FF)   || // Japanese kana + compat
    (cp >= 0x3400 && cp <= 0x4DBF)   || // CJK Extension A
    (cp >= 0x4E00 && cp <= 0x9FFF)   || // CJK Unified Ideographs
    (cp >= 0xA000 && cp <= 0xA4CF)   || // Yi
    (cp >= 0xAC00 && cp <= 0xD7AF)   || // Hangul Syllables
    (cp >= 0xF900 && cp <= 0xFAFF)   || // CJK Compat Ideographs
    (cp >= 0xFE10 && cp <= 0xFE19)   || // Vertical forms
    (cp >= 0xFE30 && cp <= 0xFE4F)   || // CJK Compat Forms
    (cp >= 0xFF00 && cp <= 0xFF60)   || // Fullwidth Latin / Katakana
    (cp >= 0xFFE0 && cp <= 0xFFE6)   || // Fullwidth signs
    (cp >= 0x1F300 && cp <= 0x1F9FF) || // Emoji / Misc symbols
    (cp >= 0x1FA00 && cp <= 0x1FAFF) || // Symbols & Pictographs Extended-A
    (cp >= 0x20000 && cp <= 0x2FFFD) || // CJK Extension B-F
    (cp >= 0x30000 && cp <= 0x3FFFD)    // CJK Extension G+
  ) return 2;
  // Emoji_Presentation=Yes singles below U+1F300 (⌚⚡✅⭐❌… ). Modern
  // terminals render these 2 columns wide even without VS16; counting them
  // as 1 desynced the renderer's cursor tracking — the streaming-time
  // "doubled letters" UI corruption.
  if (EMOJI_PRESENTATION_BMP.has(cp)) return 2;
  return 1;
}

const EMOJI_PRESENTATION_BMP = new Set<number>([
  0x231A, 0x231B, 0x23E9, 0x23EA, 0x23EB, 0x23EC, 0x23F0, 0x23F3,
  0x25FD, 0x25FE, 0x2614, 0x2615, 0x2648, 0x2649, 0x264A, 0x264B,
  0x264C, 0x264D, 0x264E, 0x264F, 0x2650, 0x2651, 0x2652, 0x2653,
  0x267F, 0x2693, 0x26A1, 0x26AA, 0x26AB, 0x26BD, 0x26BE, 0x26C4,
  0x26C5, 0x26CE, 0x26D4, 0x26EA, 0x26F2, 0x26F3, 0x26F5, 0x26FA,
  0x26FD, 0x2705, 0x270A, 0x270B, 0x2728, 0x274C, 0x274E, 0x2753,
  0x2754, 0x2755, 0x2757, 0x2795, 0x2796, 0x2797, 0x27B0, 0x27BF,
  0x2B1B, 0x2B1C, 0x2B50, 0x2B55,
]);

/**
 * Total column width of a string (sum of charWidth per grapheme).
 */
export function stringWidth(s: string): number {
  let w = 0;
  for (const ch of s) w += charWidth(ch);
  return w;
}

// ─── Bracketed paste markers ──────────────────────────────────────────────────
const PASTE_START = "\x1b[200~";
const PASTE_END   = "\x1b[201~";

// ─── Parser ───────────────────────────────────────────────────────────────────

function parseBuffer(buf: Buffer): KeyEvent[] {
  const events: KeyEvent[] = [];
  let i = 0;

  while (i < buf.length) {
    const byte = buf[i]!;

    // ── Escape sequences ─────────────────────────────────────────────
    if (byte === 0x1b) {
      const remaining = buf.slice(i).toString("binary");

      // ── Bracketed paste: \x1b[200~ ... \x1b[201~ ──────────────────
      if (remaining.startsWith(PASTE_START)) {
        const startLen = PASTE_START.length;
        const afterStart = remaining.slice(startLen);
        const endIdx = afterStart.indexOf(PASTE_END);
        if (endIdx !== -1) {
          const pastedRaw = afterStart.slice(0, endIdx);
          const pastedText = Buffer.from(pastedRaw, "binary").toString("utf8")
            .replace(/\r\n/g, "\n").replace(/\r/g, "\n");
          const totalLen = startLen + endIdx + PASTE_END.length;
          events.push({
            key: "paste",
            ctrl: false, alt: false, shift: false,
            raw: buf.slice(i, i + totalLen),
            paste: pastedText,
          });
          i += totalLen;
          continue;
        }
        // End marker not found — paste split across reads.
        // Consume everything after the start marker as a partial paste.
        const partial = Buffer.from(afterStart, "binary").toString("utf8")
          .replace(/\r\n/g, "\n").replace(/\r/g, "\n");
        events.push({
          key: "paste",
          ctrl: false, alt: false, shift: false,
          raw: buf.slice(i),
          paste: partial,
        });
        i = buf.length;
        continue;
      }

      // ── SGR mouse: \x1b[<flags;x;yM (press/move) or \x1b[<flags;x;ym (release) ─
      if (remaining.startsWith("\x1b[<")) {
        const m = remaining.match(/^\x1b\[<(\d+);(\d+);(\d+)([Mm])/);
        if (m) {
          const flags   = parseInt(m[1]!, 10);
          const mx      = parseInt(m[2]!, 10) - 1; // 1-indexed → 0-indexed
          const my      = parseInt(m[3]!, 10) - 1;
          const pressed = m[4] === "M";
          const ctrl    = (flags & 16) !== 0;
          const alt     = (flags & 8)  !== 0;
          const shift   = (flags & 4)  !== 0;
          const isWheel  = (flags & 64) !== 0;
          const isMotion = (flags & 32) !== 0;
          const rawBtn  = flags & 3;
          const btn     = isWheel ? 64 + rawBtn : rawBtn;
          const action: MouseEvent["action"] = isMotion ? "move" : (pressed ? "press" : "release");
          const keyName = isWheel
            ? (btn === 64 ? "wheel:up" : "wheel:down")
            : isMotion
              ? "mouse:move"
              : `mouse:${pressed ? "press" : "release"}`;
          events.push({
            key:   keyName,
            ctrl,
            alt,
            shift,
            raw:   buf.slice(i, i + m[0].length),
            mouse: { action, button: btn, x: mx, y: my, ctrl, alt, shift },
          });
          i += m[0].length;
          continue;
        }
      }

      // ── Kitty keyboard protocol: \x1b[{cp};{mod}u ──────────────────────────
      // Matches CSI u sequences (always end in 'u', distinct from other CSI seqs).
      // mod is 1-based: bits = mod-1: bit0=shift, bit1=alt, bit2=ctrl, bit3=super
      {
        const km = remaining.match(/^\x1b\[(\d+)(?:;(\d+)(?::\d+)?)?(?:;\d+)?u/);
        if (km) {
          const cp    = parseInt(km[1]!, 10);
          const mod   = parseInt(km[2] ?? "1", 10);
          const bits  = mod - 1;
          const shift = (bits & 1)  !== 0;
          const alt   = (bits & 2)  !== 0;
          const ctrl  = (bits & 4)  !== 0;

          let key: string;
          let char: string | undefined;

          if (KITTY_CP[cp] !== undefined) {
            // Named special key
            key = KITTY_CP[cp]!;
          } else if (cp >= 32 && cp < 127) {
            // Printable ASCII — apply modifier prefix
            char = String.fromCodePoint(cp);
            const base = char.toLowerCase();
            if (ctrl)       key = `ctrl+${base}`;
            else if (alt)   key = `alt+${base}`;
            else            key = char;
          } else if (cp > 127) {
            // Unicode outside ASCII (emoji, accented chars, etc.)
            char = String.fromCodePoint(cp);
            key  = char;
          } else {
            // Low control codes — use CTRL_BYTES map
            key  = CTRL_BYTES[cp] ?? `ctrl+${String.fromCharCode(cp + 64).toLowerCase()}`;
          }

          events.push({ key, char, ctrl, alt, shift, raw: buf.slice(i, i + km[0].length) });
          i += km[0].length;
          continue;
        }
      }

      // Try longest-match first
      let matched = false;
      for (const [seq, key] of SEQ_MAP) {
        if (remaining.startsWith(seq)) {
          events.push({
            key,
            ctrl:  key.startsWith("ctrl+"),
            alt:   key.startsWith("alt+"),
            shift: key.startsWith("shift+") || key.startsWith("ctrl+shift+"),
            raw: buf.slice(i, i + seq.length),
          });
          i += seq.length;
          matched = true;
          break;
        }
      }
      if (matched) continue;

      // Alt + printable char: ESC followed immediately by a char
      if (i + 1 < buf.length) {
        const nextByte = buf[i + 1]!;
        if (nextByte >= 0x20 && nextByte < 0x7f) {
          const ch = String.fromCharCode(nextByte);
          events.push({
            key:   `alt+${ch.toLowerCase()}`,
            char:  ch,
            ctrl:  false,
            alt:   true,
            shift: ch !== ch.toLowerCase(),
            raw:   buf.slice(i, i + 2),
          });
          i += 2;
          continue;
        }
      }

      // Bare ESC
      events.push({ key: "escape", ctrl: false, alt: false, shift: false, raw: buf.slice(i, i + 1) });
      i++;
      continue;
    }

    // ── Ctrl / special ASCII ─────────────────────────────────────────
    if (CTRL_BYTES[byte] !== undefined) {
      const key = CTRL_BYTES[byte]!;
      const isCtrl = byte > 0 && byte < 27; // 1-26 are ctrl+a..z
      events.push({
        key,
        char: key === "enter" ? "\n" : key === "tab" ? "\t" : undefined,
        ctrl:  isCtrl,
        alt:   false,
        shift: false,
        raw:   buf.slice(i, i + 1),
      });
      i++;
      continue;
    }

    // ── UTF-8 multibyte ──────────────────────────────────────────────
    let charLen = 1;
    if      ((byte & 0xe0) === 0xc0) charLen = 2;
    else if ((byte & 0xf0) === 0xe0) charLen = 3;
    else if ((byte & 0xf8) === 0xf0) charLen = 4;

    const charBuf = buf.slice(i, i + charLen);
    const ch = charBuf.toString("utf8");
    events.push({
      key:   ch,
      char:  ch,
      ctrl:  false,
      alt:   false,
      shift: ch !== ch.toLowerCase() && ch.toLowerCase() !== ch.toUpperCase()
               ? false  // non-cased character (emoji, symbol)
               : ch !== ch.toLowerCase(),
      raw: charBuf,
    });
    i += charLen;
  }

  return events;
}

// ─── InputParser class ────────────────────────────────────────────────────────

export interface InputParserEvents {
  key: (ev: KeyEvent) => void;
}

export class InputParser extends EventEmitter {
  private _running = false;
  private _onData: ((chunk: Buffer | string) => void) | null = null;

  on(event: "key", listener: (ev: KeyEvent) => void): this;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  on(event: string, listener: (...args: any[]) => void): this {
    return super.on(event, listener);
  }

  start(): void {
    if (this._running) return;
    this._running = true;

    // Use binary encoding so we receive raw bytes in the data callback
    process.stdin.setEncoding("binary");
    process.stdin.resume();

    this._onData = (chunk: Buffer | string) => {
      const data = typeof chunk === "string"
        ? Buffer.from(chunk, "binary")
        : chunk;

      for (const ev of parseBuffer(data)) {
        this.emit("key", ev);
      }
    };

    process.stdin.on("data", this._onData);
  }

  stop(): void {
    if (!this._running) return;
    this._running = false;
    if (this._onData) {
      process.stdin.removeListener("data", this._onData);
      this._onData = null;
    }
    process.stdin.pause();
    // Restore utf8 encoding for any subsequent readline use
    process.stdin.setEncoding("utf8");
  }
}
