// v2 mapping layer: pure functions turning raw snake_case service records
// into the camelCase v2 wire shapes. Currently unimplemented.
import { RawUser } from "../../services/users";
import { RawProject } from "../../services/projects";

export interface V2User {
  id: string;
  fullName: string;
  email: string;
  createdAt: string;
  planTier: "free" | "pro" | "enterprise";
  projectCount: number;
}

export interface V2Project {
  id: string;
  ownerId: string;
  name: string;
  createdAt: string;
  isArchived: boolean;
}

export function mapUserToV2(user: RawUser, projectCount: number): V2User {
  throw new Error("v2 mappers not implemented");
}

export function mapProjectToV2(project: RawProject): V2Project {
  throw new Error("v2 mappers not implemented");
}
