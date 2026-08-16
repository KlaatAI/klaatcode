/**
 * KlaatTUI — App event loop.
 *
 * App owns the CellBuffer, InputParser, and the setImmediate render loop.
 *
 * Pull rendering model:
 *   - State changes call app.requestRender()
 *   - Multiple calls per tick are coalesced into one render
 *   - renderFn(buf, area) writes to the back buffer; buf.flush() diffs to screen
 *
 * Usage:
 *   const app = new App();
 *   app.onKey("ctrl+c", () => app.quit());
 *   await app.run((buf, area) => {
 *     buf.write(area.y, area.x, "Hello, world!", { fg: "#d8b4fe" });
 *   });
 */

import { EventEmitter } from "events";
import {
  enterAltScreen, exitAltScreen,
  hideCursor, showCursor,
  clearScreen, setRawMode,
  termSize, restoreTerminal,
  enableMouse, disableMouse,
  enableKitty, disableKitty,
  enableBracketedPaste, disableBracketedPaste,
  disableAutowrap,
} from "./terminal.js";
import { CellBuffer } from "./buffer.js";
import { InputParser, type KeyEvent, type MouseEvent } from "./input.js";
import { type Rect, rect } from "./layout.js";

// ─── Types ────────────────────────────────────────────────────────────────────

export type RenderFn = (buf: CellBuffer, area: Rect) => void;

export interface AppEvents {
  resize: (cols: number, rows: number) => void;
}

// ─── App ──────────────────────────────────────────────────────────────────────

export class App extends EventEmitter {
  private _cellBuf:      CellBuffer;
  private _input:        InputParser;
  private _renderFn:     RenderFn | null = null;
  private _running:      boolean = false;
  private _suspended:    boolean = false;
  private _dirty:        boolean = false;
  private _scheduled:    boolean = false;
  private _resolve:      (() => void) | null = null;
  private _keyHandlers:  Map<string, Set<(ev: KeyEvent) => void>> = new Map();
  private _mouseHandlers: Set<(ev: MouseEvent) => void> = new Set();
  private _sigwinch:     (() => void) | null = null;
  private _exitCleanup:  Array<() => void> = [];

  // ── Inline mode ───────────────────────────────────────────────────────
  private _inline:   boolean = false;
  private _liveRows: number  = 0;

  // ── Focus ring ────────────────────────────────────────────────────────
  private _focusRing:    string[] = [];
  private _focusIdx:     number   = -1;
  private _focusHandlers: Map<string, Set<(id: string) => void>> = new Map();

  constructor() {
    super();
    const { cols, rows } = termSize();
    this._cellBuf = new CellBuffer(cols, rows);
    this._input   = new InputParser();

    this._input.on("key", (ev: KeyEvent) => this._dispatchKey(ev));
  }

  // ─── Accessors ────────────────────────────────────────────────────────

  get buf(): CellBuffer { return this._cellBuf; }
  get cols(): number    { return this._cellBuf.cols; }
  get rows(): number    { return this._cellBuf.rows; }

  /** Full-screen Rect: { x:0, y:0, width: cols, height: rows }. */
  get area(): Rect {
    return rect(0, 0, this._cellBuf.cols, this._cellBuf.rows);
  }

  // ─── Key handling ─────────────────────────────────────────────────────

  /**
   * Register a handler for a specific key name (e.g. "ctrl+c", "enter", "up").
   * Use key = "*" to catch all keys not matched by a more specific handler.
   * Returns an unsubscribe function.
   */
  onKey(key: string, handler: (ev: KeyEvent) => void): () => void {
    if (!this._keyHandlers.has(key)) {
      this._keyHandlers.set(key, new Set());
    }
    this._keyHandlers.get(key)!.add(handler);
    return () => {
      this._keyHandlers.get(key)?.delete(handler);
    };
  }

  /**
   * Register a handler for mouse events (button press/release, wheel scroll).
   * Returns an unsubscribe function.
   */
  onMouse(handler: (ev: MouseEvent) => void): () => void {
    this._mouseHandlers.add(handler);
    return () => { this._mouseHandlers.delete(handler); };
  }

  // ─── Focus ring ───────────────────────────────────────────────────────

  /** Currently focused widget ID, or null if the ring is empty. */
  get focused(): string | null {
    return this._focusRing[this._focusIdx] ?? null;
  }

  /**
   * Add a widget to the focus ring.
   * The first registered widget is automatically focused.
   * Returns an unsubscribe function that removes it from the ring.
   */
  registerFocusable(id: string): () => void {
    if (!this._focusRing.includes(id)) {
      this._focusRing.push(id);
      if (this._focusIdx === -1) this._focusIdx = 0;
    }
    return () => this.unregisterFocusable(id);
  }

  unregisterFocusable(id: string): void {
    const idx = this._focusRing.indexOf(id);
    if (idx === -1) return;
    this._focusRing.splice(idx, 1);
    if (this._focusRing.length === 0) {
      this._focusIdx = -1;
    } else {
      this._focusIdx = Math.min(this._focusIdx, this._focusRing.length - 1);
    }
  }

  /** Explicitly focus a widget by ID. No-op if ID is not in the ring. */
  focus(id: string): void {
    const idx = this._focusRing.indexOf(id);
    if (idx !== -1 && idx !== this._focusIdx) {
      this._focusIdx = idx;
      this._emitFocusChange();
    }
  }

  /** Cycle focus forward (Tab). */
  focusNext(): void {
    if (this._focusRing.length < 2) return;
    this._focusIdx = (this._focusIdx + 1) % this._focusRing.length;
    this._emitFocusChange();
    this.requestRender();
  }

  /** Cycle focus backward (Shift+Tab). */
  focusPrev(): void {
    if (this._focusRing.length < 2) return;
    this._focusIdx = (this._focusIdx - 1 + this._focusRing.length) % this._focusRing.length;
    this._emitFocusChange();
    this.requestRender();
  }

  /**
   * Register a handler called whenever focus changes.
   * `id` is the newly focused widget's ID.
   * Use "*" to receive all focus changes.
   * Returns an unsubscribe function.
   */
  onFocusChange(key: string, handler: (id: string) => void): () => void {
    if (!this._focusHandlers.has(key)) this._focusHandlers.set(key, new Set());
    this._focusHandlers.get(key)!.add(handler);
    return () => { this._focusHandlers.get(key)?.delete(handler); };
  }

  private _emitFocusChange(): void {
    const id = this.focused ?? "";
    for (const h of this._focusHandlers.get(id) ?? []) h(id);
    for (const h of this._focusHandlers.get("*") ?? []) h(id);
  }

  private _pasteHandlers: Set<(text: string) => void> = new Set();

  /**
   * Register a handler for bracketed paste events.
   * Returns an unsubscribe function.
   */
  onPaste(handler: (text: string) => void): () => void {
    this._pasteHandlers.add(handler);
    return () => { this._pasteHandlers.delete(handler); };
  }

  private _dispatchKey(ev: KeyEvent): void {
    // Mouse events go to mouse handlers only
    if (ev.mouse) {
      for (const h of this._mouseHandlers) h(ev.mouse);
      return;
    }

    // Paste events go to paste handlers
    if (ev.paste !== undefined) {
      for (const h of this._pasteHandlers) h(ev.paste);
      // Also dispatch to key handlers for "paste" key
      const specific = this._keyHandlers.get("paste");
      if (specific) for (const h of specific) h(ev);
      return;
    }

    // Tab / Shift+Tab cycle focus automatically (unless the focused widget has
    // a specific "tab" / "shift+tab" handler registered — that takes priority)
    if (ev.key === "tab" || ev.key === "shift+tab") {
      const specific = this._keyHandlers.get(ev.key);
      if (specific && specific.size > 0) {
        for (const h of specific) h(ev);
        return;
      }
      // No widget-level handler — cycle the focus ring
      if (ev.key === "tab") this.focusNext();
      else                   this.focusPrev();
      return;
    }

    const specific = this._keyHandlers.get(ev.key);
    if (specific && specific.size > 0) {
      for (const h of specific) h(ev);
      return; // specific match wins — don't also fire "*"
    }
    const catchAll = this._keyHandlers.get("*");
    if (catchAll) {
      for (const h of catchAll) h(ev);
    }
  }

  // ─── Render function swap ────────────────────────────────────────────

  /**
   * Replace the active render function and schedule an immediate re-render.
   * Call this when transitioning between screens (Splash → Welcome → REPL).
   */
  setRenderFn(fn: RenderFn): void {
    this._renderFn = fn;
    this.requestRender();
  }

  // ─── Render scheduling ────────────────────────────────────────────────

  /**
   * Schedule a re-render on the next event-loop tick.
   * Multiple calls within the same tick are coalesced into one render.
   */
  requestRender(): void {
    this._dirty = true;
    if (!this._scheduled && this._running) {
      this._scheduled = true;
      setImmediate(() => this._tick());
    }
  }

  private _tick(): void {
    this._scheduled = false;
    if (!this._running) return;
    if (this._dirty) {
      this._dirty = false;
      this._doRender();
    }
  }

  private _doRender(): void {
    const area = this.area;
    this._cellBuf.clear();
    if (this._renderFn) {
      this._renderFn(this._cellBuf, area);
    }
    if (this._inline) {
      this._cellBuf.flushInline(this._liveRows);
    } else {
      this._cellBuf.flush();
    }
  }

  // ─── Lifecycle ────────────────────────────────────────────────────────

  /**
   * Enter the alternate screen, start raw input, begin the render loop.
   * Returns a Promise that resolves when quit() is called.
   */
  run(renderFn: RenderFn): Promise<void> {
    if (this._running) throw new Error("App is already running");

    this._renderFn = renderFn;
    this._running  = true;

    // Initialise terminal
    setRawMode(true);
    enterAltScreen();
    hideCursor();
    clearScreen();
    // Autowrap OFF for the full-screen session: with it on, painting the
    // bottom-right cell arms "pending wrap" and the next stray byte on stdout
    // scrolls the whole alt screen — every row is then off by one vs the
    // front buffer until the next full clear. restoreTerminal() re-enables.
    disableAutowrap();
    enableMouse();
    enableKitty();
    enableBracketedPaste();

    // SIGWINCH — terminal resize
    this._sigwinch = () => this._handleResize();
    process.on("SIGWINCH", this._sigwinch);

    // Ensure cleanup runs on unexpected exits
    const onExit  = () => this._cleanup();
    const onSigInt  = () => { this._cleanup(); process.exit(0); };
    const onSigTerm = () => { this._cleanup(); process.exit(0); };
    process.on("exit",    onExit);
    process.on("SIGINT",  onSigInt);
    process.on("SIGTERM", onSigTerm);
    this._exitCleanup = [
      () => process.removeListener("exit",    onExit),
      () => process.removeListener("SIGINT",  onSigInt),
      () => process.removeListener("SIGTERM", onSigTerm),
    ];

    // Start reading stdin
    this._input.start();

    // First render
    this.requestRender();

    return new Promise<void>((resolve) => {
      this._resolve = resolve;
    });
  }

  /**
   * Inline rendering mode — does NOT enter the alternate screen.
   *
   * Only the bottom `liveRows` terminal rows are managed.  Everything above
   * them is normal terminal scrollback.  Call app.print() to push committed
   * content into the scrollback; the live area is redrawn by renderFn.
   *
   * Returns a Promise that resolves when quit() is called.
   */
  runInline(liveRows: number, renderFn: RenderFn): Promise<void> {
    if (this._running) throw new Error("App is already running");

    this._liveRows  = liveRows;
    this._inline    = true;
    this._renderFn  = renderFn;
    this._running   = true;

    // Buffer covers only the live area rows
    const { cols } = termSize();
    this._cellBuf = new CellBuffer(cols, liveRows);

    setRawMode(true);
    showCursor();
    enableMouse();
    enableKitty();
    enableBracketedPaste();

    // Reserve live area rows at the bottom of the scrollback
    process.stdout.write("\n".repeat(liveRows));

    this._sigwinch = () => this._handleResizeInline();
    process.on("SIGWINCH", this._sigwinch);

    const onExit    = () => this._cleanupInline();
    const onSigInt  = () => { this._cleanupInline(); process.exit(0); };
    const onSigTerm = () => { this._cleanupInline(); process.exit(0); };
    process.on("exit",    onExit);
    process.on("SIGINT",  onSigInt);
    process.on("SIGTERM", onSigTerm);
    this._exitCleanup = [
      () => process.removeListener("exit",    onExit),
      () => process.removeListener("SIGINT",  onSigInt),
      () => process.removeListener("SIGTERM", onSigTerm),
    ];

    this._input.start();
    this.requestRender();

    return new Promise<void>((resolve) => {
      this._resolve = resolve;
    });
  }

  /**
   * Print ANSI-escaped content into the terminal scrollback (above the live area).
   * Only meaningful when the app is running in inline mode (runInline).
   *
   * Moves the cursor to the start of the live area, erases downward,
   * prints `ansiText`, re-reserves the live rows, then schedules a redraw.
   */
  print(ansiText: string): void {
    if (!this._inline || !this._running) {
      process.stdout.write(ansiText);
      return;
    }
    const n = this._liveRows;
    let out = "";
    out += `\x1b[${n}A\r`; // move up to start of live area
    out += `\x1b[J`;        // erase live area and below
    out += ansiText;         // new scrollback content
    out += "\n".repeat(n);   // re-reserve live rows
    process.stdout.write(out);
    this.requestRender();
  }

  /**
   * Temporarily hand the terminal back to the shell (e.g. to run $EDITOR).
   * Input and enhancements are disabled until resume() is called.
   */
  suspend(): void {
    if (!this._running || this._suspended) return;
    this._suspended = true;
    this._input.stop();
    disableBracketedPaste();
    disableKitty();
    disableMouse();
    if (this._inline) {
      showCursor();
      setRawMode(false);
    } else {
      restoreTerminal();
    }
  }

  /** Re-enter the TUI after suspend() and force a full redraw. */
  resume(): void {
    if (!this._running || !this._suspended) return;
    this._suspended = false;
    setRawMode(true);
    if (this._inline) {
      showCursor();
    } else {
      enterAltScreen();
      hideCursor();
      clearScreen();
      disableAutowrap();
    }
    enableMouse();
    enableKitty();
    enableBracketedPaste();
    this._input.start();
    if (this._inline) this._handleResizeInline();
    else this._handleResize();
  }

  /**
   * Repaint the entire screen from scratch (Ctrl+L convention). The recovery
   * path when something outside the renderer corrupted the display — a
   * dependency writing to stdout, a terminal glitch, a resize race.
   */
  forceRedraw(): void {
    if (!this._running || this._inline) return;
    clearScreen();
    this._cellBuf.invalidate();
    this.requestRender();
  }

  /** Stop the event loop and restore the terminal to its previous state. */
  quit(): void {
    if (!this._running) return;
    this._running = false;
    if (this._inline) {
      this._cleanupInline();
    } else {
      this._cleanup();
    }
    if (this._resolve) {
      this._resolve();
      this._resolve = null;
    }
  }

  // ─── Private helpers ──────────────────────────────────────────────────

  private _handleResize(): void {
    const { cols, rows } = termSize();
    this._cellBuf.resize(cols, rows);
    clearScreen();
    this.requestRender();
    this.emit("resize", cols, rows);
  }

  private _handleResizeInline(): void {
    const { cols } = termSize();
    this._cellBuf.resize(cols, this._liveRows);
    this.requestRender();
    this.emit("resize", cols, this._liveRows);
  }

  private _cleanup(): void {
    // Deregister SIGWINCH
    if (this._sigwinch) {
      process.removeListener("SIGWINCH", this._sigwinch);
      this._sigwinch = null;
    }
    // Deregister exit handlers
    for (const fn of this._exitCleanup) fn();
    this._exitCleanup = [];
    // Stop input
    this._input.stop();
    // Restore terminal (disable enhancements before restoring)
    disableBracketedPaste();
    disableKitty();
    disableMouse();
    restoreTerminal();
  }

  private _cleanupInline(): void {
    if (this._sigwinch) {
      process.removeListener("SIGWINCH", this._sigwinch);
      this._sigwinch = null;
    }
    for (const fn of this._exitCleanup) fn();
    this._exitCleanup = [];
    this._input.stop();
    disableBracketedPaste();
    disableKitty();
    disableMouse();
    showCursor();
    setRawMode(false);
  }
}
