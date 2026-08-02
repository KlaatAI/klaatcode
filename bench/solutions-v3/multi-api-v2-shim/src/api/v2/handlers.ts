// v2 API handlers. Envelope:
//   { status: "success", result, meta: { version: 2, ... } }
//   { status: "error", error: { code }, meta: { version: 2 } }
// Reuses the same services as v1; field mapping delegated to ./mappers.
import { getUserById } from "../../services/users";
import { listProjectsByOwner } from "../../services/projects";
import { mapUserToV2, mapProjectToV2, V2User, V2Project } from "./mappers";

export interface V2Meta {
  version: 2;
  count?: number;
}

export type V2Response<T> =
  | { status: "success"; result: T; meta: V2Meta }
  | { status: "error"; error: { code: string }; meta: V2Meta };

function errorResponse<T>(code: string): V2Response<T> {
  return { status: "error", error: { code }, meta: { version: 2 } };
}

export function getUser(id: string): V2Response<V2User> {
  const user = getUserById(id);
  if (!user) return errorResponse("user_not_found");
  const projectCount = listProjectsByOwner(id).length;
  return { status: "success", result: mapUserToV2(user, projectCount), meta: { version: 2 } };
}

export function listProjects(ownerId: string): V2Response<V2Project[]> {
  const owner = getUserById(ownerId);
  if (!owner) return errorResponse("user_not_found");
  const projects = listProjectsByOwner(ownerId).map(mapProjectToV2);
  return { status: "success", result: projects, meta: { version: 2, count: projects.length } };
}
