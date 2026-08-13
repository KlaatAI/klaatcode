// v2 API handlers. Envelope:
//   { status: "success", result, meta: { version: 2, ... } }
//   { status: "error", error: { code }, meta: { version: 2 } }
// Must reuse the same services/business logic as v1 — do not duplicate it.
import { V2User, V2Project } from "./mappers";

export interface V2Meta {
  version: 2;
  count?: number;
}

export type V2Response<T> =
  | { status: "success"; result: T; meta: V2Meta }
  | { status: "error"; error: { code: string }; meta: V2Meta };

export function getUser(id: string): V2Response<V2User> {
  throw new Error("v2 handlers not implemented");
}

export function listProjects(ownerId: string): V2Response<V2Project[]> {
  throw new Error("v2 handlers not implemented");
}
