import { test, expect } from "bun:test";
import { getUser, listProjects } from "./handlers";

test("v2 getUser wraps the user in the v2 envelope with camelCase fields", () => {
  const response = getUser("u1");
  expect(response.status).toBe("success");
  if (response.status === "success") {
    expect(response.result).toEqual({
      id: "u1",
      fullName: "Ada Lovelace",
      email: "ada@example.test",
      createdAt: "2024-01-15T10:00:00.000Z",
      planTier: "pro",
      projectCount: 3,
    });
    expect(response.meta.version).toBe(2);
  }
});

test("v2 getUser computes projectCount from the project service", () => {
  const response = getUser("u2");
  expect(response.status).toBe("success");
  if (response.status === "success") {
    expect(response.result.projectCount).toBe(1);
  }
});

test("v2 getUser error envelope", () => {
  expect(getUser("nope")).toEqual({
    status: "error",
    error: { code: "user_not_found" },
    meta: { version: 2 },
  });
});

test("v2 listProjects returns camelCase projects with count in meta", () => {
  const response = listProjects("u1");
  expect(response.status).toBe("success");
  if (response.status === "success") {
    expect(response.result.map((p) => p.id)).toEqual(["p1", "p2", "p3"]);
    expect(response.result[1]).toEqual({
      id: "p2",
      ownerId: "u1",
      name: "Translator Notes",
      createdAt: "2024-02-10T00:00:00.000Z",
      isArchived: true,
    });
    expect(response.meta).toEqual({ version: 2, count: 3 });
  }
});

test("v2 listProjects leaves no snake_case keys in results", () => {
  const response = listProjects("u2");
  expect(response.status).toBe("success");
  if (response.status === "success") {
    const project = response.result[0] as unknown as Record<string, unknown>;
    expect("owner_id" in project).toBe(false);
    expect("is_archived" in project).toBe(false);
  }
});

test("v2 listProjects error envelope for missing owner", () => {
  expect(listProjects("nope")).toEqual({
    status: "error",
    error: { code: "user_not_found" },
    meta: { version: 2 },
  });
});
