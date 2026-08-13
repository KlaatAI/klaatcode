import { test, expect } from "bun:test";
import { mapUserToV2, mapProjectToV2 } from "./mappers";

const rawUser = {
  id: "ux",
  full_name: "Test Person",
  email: "t@example.test",
  created_at: "2024-05-01T12:00:00.000Z",
  plan_tier: "enterprise" as const,
};

const rawProject = {
  id: "px",
  owner_id: "ux",
  name: "Skunkworks",
  created_at: "2024-06-01T00:00:00.000Z",
  is_archived: true,
};

test("mapUserToV2 renames fields to camelCase and injects projectCount", () => {
  expect(mapUserToV2(rawUser, 7)).toEqual({
    id: "ux",
    fullName: "Test Person",
    email: "t@example.test",
    createdAt: "2024-05-01T12:00:00.000Z",
    planTier: "enterprise",
    projectCount: 7,
  });
});

test("mapUserToV2 leaves no snake_case keys behind", () => {
  const mapped = mapUserToV2(rawUser, 0) as Record<string, unknown>;
  expect("full_name" in mapped).toBe(false);
  expect("created_at" in mapped).toBe(false);
  expect("plan_tier" in mapped).toBe(false);
});

test("mapProjectToV2 renames fields to camelCase", () => {
  expect(mapProjectToV2(rawProject)).toEqual({
    id: "px",
    ownerId: "ux",
    name: "Skunkworks",
    createdAt: "2024-06-01T00:00:00.000Z",
    isArchived: true,
  });
});

test("mappers are pure: inputs are not mutated", () => {
  const userCopy = { ...rawUser };
  const projectCopy = { ...rawProject };
  mapUserToV2(rawUser, 3);
  mapProjectToV2(rawProject);
  expect(rawUser).toEqual(userCopy);
  expect(rawProject).toEqual(projectCopy);
});
