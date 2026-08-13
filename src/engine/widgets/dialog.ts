/**
 * KlaatTUI — Dialog overlay system.
 *
 * Provides modal dialogs rendered as an overlay on top of the main UI.
 * Supports: list selection, text input prompts, confirmation dialogs,
 * and a command palette with fuzzy search.
 *
 * Architecture:
 *   - Dialog state is managed by a DialogManager instance.
 *   - The dialog renders itself into the CellBuffer AFTER the main render,
 *     so it appears on top.
 *   - Key events are intercepted by the dialog when active.
 *
 * Usage:
 *   const dm = new DialogManager();
 *   dm.showList("Select Model", items, (selected) => { ... });
 *   // In render:
 *   dm.render(buf, area);
 *   // In key handler:
 *   if (dm.active && dm.handleKey(ev)) return;
 */

import { type CellBuffer, type Style } from "../buffer.js";
import { type KeyEvent, type MouseEvent } from "../input.js";
import { type Rect, center } from "../layout.js";
import { drawBorder, inner } from "./border.js";
import { drawTextLine } from "./text.js";
import { stringWidth } from "../input.js";

// ─── Fuzzy matching ──────────────────────────────────────────────────────────

/**
 * Subsequence fuzzy score: every query char must appear in order in `target`.
 * Returns -1 on no match; higher is better. Bonuses for consecutive runs and
 * matches at segment starts (after / . _ - or space) so "sirepl" ranks
 * "screens/repl.ts" above scattered matches.
 */
export function fuzzyScore(query: string, target: string): number {
  const q = query.toLowerCase();
  const t = target.toLowerCase();
  if (!q) return 0;

  // Greedy scan from a given start offset.
  const scanFrom = (start: number): number => {
    let qi = 0, score = 0, streak = 0;
    for (let ti = start; ti < t.length && qi < q.length; ti++) {
      if (t[ti] === q[qi]) {
        streak++;
        score += 1 + streak * 2;
        if (ti === 0 || "/._- ".includes(t[ti - 1]!)) score += 8;
        qi++;
      } else {
        streak = 0;
      }
    }
    return qi < q.length ? -1 : score;
  };

  // A single greedy pass anchors on the FIRST occurrence of q[0], which can
  // miss a much better match later (e.g. "repl" hitting "sc-re-ens" before
  // "/repl"). Try every occurrence of the first query char, keep the best.
  let best = -1;
  for (let ti = 0; ti < t.length; ti++) {
    if (t[ti] !== q[0]) continue;
    const s = scanFrom(ti);
    if (s > best) best = s;
  }
  if (best < 0) return -1;
  // Mild penalty for long targets so tight matches win.
  return best - Math.floor((t.length - q.length) / 4);
}

// ─── Types ────────────────────────────────────────────────────────────────────

export interface ListItem {
  label:       string;
  description?: string;
  value:       string;
  /** Optional accent color for the label. */
  color?:      string;
}

export interface DialogOpts {
  title:       string;
  width?:      number;
  maxHeight?:  number;
  borderFg?:   string;
  /** Value focused when the list opens. */
  initialValue?: string;
}

type DialogState =
  | { type: "none" }
  | { type: "list"; opts: DialogOpts; items: ListItem[]; filtered: ListItem[];
      selected: number; search: string; onSelect: (item: ListItem) => void; onCancel?: () => void }
  | { type: "confirm"; opts: DialogOpts; message: string;
      onConfirm: () => void; onCancel: () => void }
  | { type: "input"; opts: DialogOpts; prompt: string; value: string;
      onSubmit: (value: string) => void; onCancel: () => void };

// ─── DialogManager ────────────────────────────────────────────────────────────

export class DialogManager {
  private _state: DialogState = { type: "none" };
  private _onRender: (() => void) | null = null;
  private _listLayout: {
    rows: Array<{ y: number; index: number }>;
    back: Rect | null;
    dialog: Rect;
  } | null = null;

  /** Set a callback to request re-render when dialog state changes. */
  setRenderCallback(cb: () => void): void {
    this._onRender = cb;
  }

  get active(): boolean {
    return this._state.type !== "none";
  }

  get type(): string {
    return this._state.type;
  }

  // ─── Show methods ────────────────────────────────────────────────────

  showList(
    title: string,
    items: ListItem[],
    onSelect: (item: ListItem) => void,
    onCancel?: () => void,
    opts: Partial<DialogOpts> = {},
  ): void {
    const initialIndex = opts.initialValue
      ? items.findIndex(item => item.value === opts.initialValue)
      : -1;
    this._state = {
      type: "list",
      opts: { title, ...opts },
      items,
      filtered: [...items],
      selected: Math.max(0, initialIndex),
      search: "",
      onSelect,
      onCancel,
    };
    this._onRender?.();
  }

  showConfirm(
    title: string,
    message: string,
    onConfirm: () => void,
    onCancel: () => void,
    opts: Partial<DialogOpts> = {},
  ): void {
    this._state = {
      type: "confirm",
      opts: { title, ...opts },
      message,
      onConfirm,
      onCancel,
    };
    this._onRender?.();
  }

  showInput(
    title: string,
    prompt: string,
    onSubmit: (value: string) => void,
    onCancel: () => void,
    opts: Partial<DialogOpts> = {},
  ): void {
    this._state = {
      type: "input",
      opts: { title, ...opts },
      prompt,
      value: "",
      onSubmit,
      onCancel,
    };
    this._onRender?.();
  }

  dismiss(): void {
    this._state = { type: "none" };
    this._listLayout = null;
    this._onRender?.();
  }

  // ─── Key handling ────────────────────────────────────────────────────

  /** Handle a key event. Returns true if consumed. */
  handleKey(ev: KeyEvent): boolean {
    const s = this._state;

    if (s.type === "list") return this._handleListKey(s, ev);
    if (s.type === "confirm") return this._handleConfirmKey(s, ev);
    if (s.type === "input") return this._handleInputKey(s, ev);

    return false;
  }

  /** Handle list hover/click interactions. Returns true when consumed. */
  handleMouse(ev: MouseEvent): boolean {
    const s = this._state;
    const layout = this._listLayout;
    if (s.type !== "list" || !layout) return false;

    const inside =
      ev.x >= layout.dialog.x && ev.x < layout.dialog.x + layout.dialog.width &&
      ev.y >= layout.dialog.y && ev.y < layout.dialog.y + layout.dialog.height;
    if (!inside) return true; // modal: swallow clicks behind the dialog

    if (layout.back &&
        ev.x >= layout.back.x && ev.x < layout.back.x + layout.back.width &&
        ev.y === layout.back.y) {
      if (ev.action === "press" && ev.button === 0) {
        s.onCancel?.();
        this.dismiss();
      }
      return true;
    }

    const row = layout.rows.find(r => r.y === ev.y);
    if (!row) return true;
    if (s.selected !== row.index) {
      s.selected = row.index;
      this._onRender?.();
    }
    if (ev.action === "press" && ev.button === 0) {
      const item = s.filtered[row.index];
      if (item) {
        this.dismiss();
        s.onSelect(item);
      }
    }
    return true;
  }

  private _handleListKey(s: Extract<DialogState, { type: "list" }>, ev: KeyEvent): boolean {
    switch (ev.key) {
      case "escape":
        s.onCancel?.();
        this.dismiss();
        return true;

      case "up":
        s.selected = Math.max(0, s.selected - 1);
        this._onRender?.();
        return true;

      case "down":
        s.selected = Math.min(s.filtered.length - 1, s.selected + 1);
        this._onRender?.();
        return true;

      case "enter":
        if (s.filtered[s.selected]) {
          const item = s.filtered[s.selected]!;
          this.dismiss();
          s.onSelect(item);
        }
        return true;

      case "backspace":
        if (s.search.length > 0) {
          s.search = s.search.slice(0, -1);
          this._filterList(s);
          this._onRender?.();
        }
        return true;

      default:
        if (ev.char && !ev.ctrl && !ev.alt) {
          s.search += ev.char;
          this._filterList(s);
          this._onRender?.();
          return true;
        }
        return true; // consume all keys when dialog is active
    }
  }

  private _filterList(s: Extract<DialogState, { type: "list" }>): void {
    const q = s.search;
    if (!q) {
      s.filtered = [...s.items];
    } else {
      s.filtered = s.items
        .map((item) => {
          const ls = fuzzyScore(q, item.label);
          const ds = item.description ? fuzzyScore(q, item.description) : -1;
          return { item, score: Math.max(ls, ds >= 0 ? ds / 2 : -1) };
        })
        .filter((x) => x.score >= 0)
        .sort((a, b) => b.score - a.score)
        .map((x) => x.item);
    }
    s.selected = Math.min(s.selected, Math.max(0, s.filtered.length - 1));
  }

  private _handleConfirmKey(s: Extract<DialogState, { type: "confirm" }>, ev: KeyEvent): boolean {
    switch (ev.key) {
      case "y": case "enter":
        this.dismiss();
        s.onConfirm();
        return true;
      case "n": case "escape":
        this.dismiss();
        s.onCancel();
        return true;
      default:
        return true;
    }
  }

  private _handleInputKey(s: Extract<DialogState, { type: "input" }>, ev: KeyEvent): boolean {
    switch (ev.key) {
      case "escape":
        this.dismiss();
        s.onCancel();
        return true;
      case "enter":
        this.dismiss();
        s.onSubmit(s.value);
        return true;
      case "backspace":
        s.value = s.value.slice(0, -1);
        this._onRender?.();
        return true;
      default:
        if (ev.char && !ev.ctrl && !ev.alt) {
          s.value += ev.char;
          this._onRender?.();
          return true;
        }
        return true;
    }
  }

  // ─── Rendering ──────────────────────────────────────────────────────

  /** Render the dialog overlay on top of the main UI. */
  render(buf: CellBuffer, area: Rect): void {
    const s = this._state;
    if (s.type === "none") return;

    if (s.type === "list") this._renderList(buf, area, s);
    else if (s.type === "confirm") this._renderConfirm(buf, area, s);
    else if (s.type === "input") this._renderInput(buf, area, s);
  }

  private _renderList(
    buf: CellBuffer, area: Rect,
    s: Extract<DialogState, { type: "list" }>,
  ): void {
    const { opts, filtered, selected, search } = s;
    const dialogW = Math.min(opts.width ?? 50, area.width - 4);
    const maxH    = opts.maxHeight ?? Math.min(filtered.length + 5, area.height - 4);
    const dialogH = Math.max(7, maxH);
    const dialogR = center(area, dialogW, dialogH);

    // Dim the background
    buf.fill(area.y, area.x, area.height, area.width, " ", { bg: null, dim: true });

    // Draw dialog border
    drawBorder(buf, dialogR, {
      style: "rounded",
      title: opts.title,
      fg: opts.borderFg ?? "#d8b4fe",
    });

    const contentR = inner(dialogR);

    // Search bar
    const searchLabel = search ? `🔍 ${search}` : "Type to search…";
    drawTextLine(buf, contentR, contentR.y, searchLabel, {
      fg: search ? "white" : "gray",
      italic: !search,
    });

    // Separator
    drawTextLine(buf, contentR, contentR.y + 1,
      "─".repeat(contentR.width), { fg: "#555" });

    // Items
    const listStart = contentR.y + 2;
    const listH     = contentR.height - 3;
    const scrollOff = Math.max(0, selected - listH + 2);
    const visibleRows: Array<{ y: number; index: number }> = [];
    const labelColW = Math.min(
      Math.max(0, contentR.width - 12),
      Math.max(0, ...filtered.map(item => stringWidth(item.label))),
    );

    for (let i = 0; i < listH && i + scrollOff < filtered.length; i++) {
      const index = i + scrollOff;
      const item = filtered[index]!;
      const isSel = index === selected;
      const row   = listStart + i;
      visibleRows.push({ y: row, index });

      if (isSel) {
        buf.fill(row, contentR.x, 1, contentR.width, " ", { bg: "#333" });
      }

      const prefix = isSel ? "❯ " : "  ";
      const labelStyle: Style = {
        fg: isSel ? (item.color ?? "white") : (item.color ?? "gray"),
        bold: isSel,
        bg: isSel ? "#333" : undefined,
      };

      buf.write(row, contentR.x, prefix, labelStyle);
      const labelMax = Math.max(0, labelColW);
      const label = stringWidth(item.label) > labelMax
        ? item.label.slice(0, Math.max(0, labelMax - 1)) + "…"
        : item.label;
      buf.write(row, contentR.x + 2, label, labelStyle);

      if (item.description) {
        const descCol = contentR.x + 2 + labelColW + 2;
        const descW = Math.max(0, contentR.x + contentR.width - descCol);
        const description = stringWidth(item.description) > descW
          ? item.description.slice(0, Math.max(0, descW - 1)) + "…"
          : item.description;
        buf.write(row, descCol, description, {
          fg: "gray", dim: true, bg: isSel ? "#333" : undefined,
        });
      }
    }

    const footerY = contentR.y + contentR.height - 1;
    const footer = "↑↓ navigate  ·  Enter select";
    drawTextLine(buf, contentR, footerY, footer, { fg: "gray", dim: true });
    const backLabel = "← Back  Esc";
    const backX = contentR.x + Math.max(0, contentR.width - stringWidth(backLabel));
    drawTextLine(
      buf,
      { x: backX, y: footerY, width: stringWidth(backLabel), height: 1 },
      footerY,
      backLabel,
      { fg: opts.borderFg ?? "#d8b4fe", bold: true },
    );
    this._listLayout = {
      rows: visibleRows,
      back: { x: backX, y: footerY, width: stringWidth(backLabel), height: 1 },
      dialog: dialogR,
    };
  }

  private _renderConfirm(
    buf: CellBuffer, area: Rect,
    s: Extract<DialogState, { type: "confirm" }>,
  ): void {
    const { opts, message } = s;
    const dialogW = Math.min(opts.width ?? 40, area.width - 4);
    const dialogH = 7;
    const dialogR = center(area, dialogW, dialogH);

    buf.fill(area.y, area.x, area.height, area.width, " ", { bg: null, dim: true });

    drawBorder(buf, dialogR, {
      style: "rounded",
      title: opts.title,
      fg: opts.borderFg ?? "yellow",
    });

    const contentR = inner(dialogR);
    drawTextLine(buf, contentR, contentR.y + 1, message, { fg: "white" });
    drawTextLine(buf, contentR, contentR.y + 3, "[Y]es  [N]o", {
      fg: "cyan", bold: true,
    }, { align: "center" });
  }

  private _renderInput(
    buf: CellBuffer, area: Rect,
    s: Extract<DialogState, { type: "input" }>,
  ): void {
    const { opts, prompt, value } = s;
    const dialogW = Math.min(opts.width ?? 50, area.width - 4);
    const dialogH = 7;
    const dialogR = center(area, dialogW, dialogH);

    buf.fill(area.y, area.x, area.height, area.width, " ", { bg: null, dim: true });

    drawBorder(buf, dialogR, {
      style: "rounded",
      title: opts.title,
      fg: opts.borderFg ?? "#d8b4fe",
    });

    const contentR = inner(dialogR);
    drawTextLine(buf, contentR, contentR.y, prompt, { fg: "gray" });
    drawTextLine(buf, contentR, contentR.y + 2, `❯ ${value}█`, { fg: "white" });
    drawTextLine(buf, contentR, contentR.y + 4, "Enter to submit · Esc to cancel", {
      fg: "gray", dim: true,
    }, { align: "center" });
  }
}
