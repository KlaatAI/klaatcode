import type { Context, Handler, KRequest, KResponse, Middleware } from "./types";
import { HttpError } from "./types";
import { normalizeHeaders } from "../util/headers";

/**
 * Compose a middleware chain in front of a terminal handler.
 *
 * Middleware runs in registration order; each middleware decides whether to
 * call `next()` (continuing down the chain) or short-circuit by writing the
 * response and returning. Calling `next()` twice from the same middleware is
 * a programming error and throws.
 */
export function compose(middlewares: Middleware[], terminal: Handler): Handler {
  return async (ctx: Context) => {
    let index = -1;

    async function invoke(i: number): Promise<void> {
      if (i <= index) {
        throw new Error("pipeline: next() called multiple times");
      }
      index = i;
      if (i === middlewares.length) {
        await terminal(ctx);
        return;
      }
      const mw = middlewares[i]!;
      await mw(ctx, () => invoke(i + 1));
    }

    await invoke(0);
  };
}

/**
 * Run a raw request through the composed handler, producing a response.
 * HttpErrors thrown anywhere in the chain map to their status; anything else
 * becomes an opaque 500 so internals never leak to clients.
 */
export async function execute(handler: Handler, req: KRequest): Promise<KResponse> {
  const ctx: Context = {
    req,
    headers: normalizeHeaders(req.headers),
    res: {
      status: 200,
      headers: {},
      body: undefined,
    },
    state: {},
  };

  try {
    await handler(ctx);
  } catch (err) {
    if (err instanceof HttpError) {
      ctx.res.status = err.status;
      ctx.res.headers["content-type"] = "application/json";
      ctx.res.body = { error: err.message };
    } else {
      ctx.res.status = 500;
      ctx.res.headers["content-type"] = "application/json";
      ctx.res.body = { error: "internal error" };
    }
  }

  return ctx.res;
}
