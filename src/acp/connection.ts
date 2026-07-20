/**
 * Bidirectional JSON-RPC 2.0 over stdio — the transport ACP runs on
 * (agentclientprotocol.com). Newline-delimited JSON in both directions.
 *
 * "Bidirectional" matters: unlike a normal client/server pair, EITHER side
 * can initiate a request. The editor calls us (`initialize`, `session/new`,
 * `session/prompt`); we call it back mid-turn (`session/request_permission`)
 * and stream progress via one-way `session/update` notifications. One id
 * space, disambiguated by shape: {method,id} = request, {method} = notif,
 * {id} alone = a response to a request WE sent.
 */

export interface JsonRpcError { code: number; message: string; data?: unknown }

type RequestHandler = (params: unknown) => Promise<unknown>;
type NotificationHandler = (params: unknown) => void;

export class AcpConnection {
  private buffer = "";
  private nextId = 1;
  private pending = new Map<number, { resolve: (v: unknown) => void; reject: (e: Error) => void }>();
  private requestHandlers = new Map<string, RequestHandler>();
  private notificationHandlers = new Map<string, NotificationHandler>();

  constructor(
    private readonly input: NodeJS.ReadableStream,
    private readonly output: NodeJS.WritableStream,
  ) {
    this.input.on("data", (chunk: Buffer) => this.onData(chunk));
  }

  onRequest(method: string, handler: RequestHandler): void {
    this.requestHandlers.set(method, handler);
  }

  onNotification(method: string, handler: NotificationHandler): void {
    this.notificationHandlers.set(method, handler);
  }

  /** Send a request to the client (editor) and await its response. */
  request(method: string, params?: unknown): Promise<unknown> {
    return new Promise((resolve, reject) => {
      const id = this.nextId++;
      this.pending.set(id, { resolve, reject });
      this.write({ jsonrpc: "2.0", id, method, params });
    });
  }

  /** Send a one-way notification to the client — no response expected. */
  notify(method: string, params?: unknown): void {
    this.write({ jsonrpc: "2.0", method, params });
  }

  private onData(chunk: Buffer): void {
    this.buffer += chunk.toString("utf-8");
    const lines = this.buffer.split("\n");
    this.buffer = lines.pop() ?? "";
    for (const raw of lines) {
      const line = raw.trim();
      if (!line) continue;
      let msg: Record<string, unknown>;
      try {
        msg = JSON.parse(line) as Record<string, unknown>;
      } catch {
        continue; // malformed line — skip rather than crash the session
      }
      // Dispatch on a fresh task, not inline: a handler that itself calls
      // write() (e.g. a notification triggering another notification) can
      // otherwise re-enter onData synchronously within the same call stack
      // — harmless over real OS pipes (always async) but blows the stack
      // fast on the in-memory PassThrough pairs the test suite uses, and
      // it's cheap insurance against the same thing happening for real.
      setImmediate(() => void this.handleMessage(msg));
    }
  }

  private async handleMessage(msg: Record<string, unknown>): Promise<void> {
    const method = msg["method"] as string | undefined;
    const id = msg["id"] as number | undefined;

    if (method && id !== undefined) {
      const handler = this.requestHandlers.get(method);
      if (!handler) {
        this.write({ jsonrpc: "2.0", id, error: { code: -32601, message: `Method not found: ${method}` } });
        return;
      }
      try {
        const result = await handler(msg["params"]);
        this.write({ jsonrpc: "2.0", id, result: result ?? null });
      } catch (err) {
        this.write({
          jsonrpc: "2.0", id,
          error: { code: -32000, message: err instanceof Error ? err.message : String(err) },
        });
      }
      return;
    }

    if (method) {
      this.notificationHandlers.get(method)?.(msg["params"]);
      return;
    }

    if (id !== undefined) {
      const p = this.pending.get(id);
      if (!p) return;
      this.pending.delete(id);
      const error = msg["error"] as JsonRpcError | undefined;
      if (error) p.reject(new Error(error.message));
      else p.resolve(msg["result"]);
    }
  }

  private write(msg: unknown): void {
    try {
      this.output.write(JSON.stringify(msg) + "\n");
    } catch {
      // Editor closed the pipe — nothing to recover, the process exits on stdin end.
    }
  }
}
