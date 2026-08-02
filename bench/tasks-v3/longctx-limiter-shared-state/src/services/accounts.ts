import type { Context } from "../http/types";
import { jsonOk, jsonError } from "../http/types";
import type { Directory } from "../services/directory";

/**
 * Account service: read-only profile endpoints backed by the directory.
 * Handlers assume `authenticate` already populated ctx.state.
 */
export class AccountsService {
  constructor(private readonly directory: Directory) {}

  /** GET /accounts/me — the caller's own profile. */
  async me(ctx: Context): Promise<void> {
    const userId = ctx.state.userId!;
    const record = this.directory.lookupUser(userId);
    if (!record) {
      jsonError(ctx, 404, "account not found");
      return;
    }
    jsonOk(ctx, {
      id: record.id,
      role: record.role,
      displayName: record.displayName,
    });
  }

  /** GET /accounts/:id — admins may read anyone; others only themselves. */
  async byId(ctx: Context): Promise<void> {
    const targetId = ctx.state.routeParams?.id ?? "";
    const callerId = ctx.state.userId!;
    const callerRole = ctx.state.userRole;
    if (targetId !== callerId && callerRole !== "admin") {
      jsonError(ctx, 403, "cannot read other accounts");
      return;
    }
    const record = this.directory.lookupUser(targetId);
    if (!record) {
      jsonError(ctx, 404, "account not found");
      return;
    }
    jsonOk(ctx, {
      id: record.id,
      role: record.role,
      displayName: record.displayName,
    });
  }
}
