// v1 API handlers. Envelope: { ok: true, data } | { ok: false, error }.
// Fields pass through in the services' snake_case shape.
import { getUserById, RawUser } from "../../services/users";
import { listProjectsByOwner, RawProject } from "../../services/projects";

export type V1Response<T> = { ok: true; data: T } | { ok: false; error: string };

export function getUser(id: string): V1Response<RawUser> {
  const user = getUserById(id);
  if (!user) return { ok: false, error: "user_not_found" };
  return { ok: true, data: user };
}

export function listProjects(ownerId: string): V1Response<RawProject[]> {
  const owner = getUserById(ownerId);
  if (!owner) return { ok: false, error: "user_not_found" };
  return { ok: true, data: listProjectsByOwner(ownerId) };
}
