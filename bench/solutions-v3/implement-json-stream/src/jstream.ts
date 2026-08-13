/**
 * Incremental scanner for a stream of whitespace-separated JSON values.
 * See the task spec: feed(chunk) returns each value completed by that chunk
 * (parsed via JSON.parse), tolerating arbitrary chunk boundaries; end()
 * throws if a partially-buffered value remains.
 */

const WS = new Set([" ", "\t", "\n", "\r"]);

type Mode = "idle" | "string" | "container" | "primitive";

export class JsonValueScanner {
  private buf = "";
  private pos = 0;
  private start = -1;
  private mode: Mode = "idle";
  private depth = 0;
  private inStr = false;
  private esc = false;
  private ended = false;

  feed(chunk: string): unknown[] {
    if (this.ended) throw new Error("feed() called after end()");
    this.buf += chunk;
    const out: unknown[] = [];

    while (this.pos < this.buf.length) {
      const c = this.buf[this.pos];

      if (this.mode === "idle") {
        if (WS.has(c)) {
          this.pos++;
          continue;
        }
        this.start = this.pos;
        if (c === '"') {
          this.mode = "string";
          this.esc = false;
          this.pos++;
        } else if (c === "{" || c === "[") {
          this.mode = "container";
          this.depth = 1;
          this.inStr = false;
          this.esc = false;
          this.pos++;
        } else {
          this.mode = "primitive";
          this.pos++;
        }
        continue;
      }

      if (this.mode === "string") {
        if (this.esc) {
          this.esc = false;
          this.pos++;
        } else if (c === "\\") {
          this.esc = true;
          this.pos++;
        } else if (c === '"') {
          this.pos++;
          this.emit(out);
        } else {
          this.pos++;
        }
        continue;
      }

      if (this.mode === "container") {
        if (this.inStr) {
          if (this.esc) this.esc = false;
          else if (c === "\\") this.esc = true;
          else if (c === '"') this.inStr = false;
          this.pos++;
        } else if (c === '"') {
          this.inStr = true;
          this.esc = false;
          this.pos++;
        } else if (c === "{" || c === "[") {
          this.depth++;
          this.pos++;
        } else if (c === "}" || c === "]") {
          this.depth--;
          this.pos++;
          if (this.depth === 0) this.emit(out);
        } else {
          this.pos++;
        }
        continue;
      }

      // primitive: number or true/false/null — ends only at whitespace
      if (WS.has(c)) {
        this.emit(out);
      } else {
        this.pos++;
      }
    }

    if (this.mode === "idle") {
      // everything consumed; drop the buffer
      this.buf = "";
      this.pos = 0;
    }
    return out;
  }

  private emit(out: unknown[]): void {
    out.push(JSON.parse(this.buf.slice(this.start, this.pos)));
    this.mode = "idle";
    this.start = -1;
  }

  end(): void {
    this.ended = true;
    if (this.mode !== "idle") {
      throw new Error("incomplete JSON value at end of stream");
    }
  }
}
