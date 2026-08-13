// v2 mapping layer: pure functions turning raw snake_case service records
// into the camelCase v2 wire shapes.
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
  return {
    id: user.id,
    fullName: user.full_name,
    email: user.email,
    createdAt: user.created_at,
    planTier: user.plan_tier,
    projectCount,
  };
}

export function mapProjectToV2(project: RawProject): V2Project {
  return {
    id: project.id,
    ownerId: project.owner_id,
    name: project.name,
    createdAt: project.created_at,
    isArchived: project.is_archived,
  };
}
