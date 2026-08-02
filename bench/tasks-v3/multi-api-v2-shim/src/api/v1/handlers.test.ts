import { test, expect } from "bun:test";
import { getUser, listProjects } from "./handlers";

test("v1 getUser returns the snake_case envelope", () => {
  const response = getUser("u1");
  expect(response.ok).toBe(true);
  if (response.ok) {
    expect(response.data.full_name).toBe("Ada Lovelace");
    expect(response.data.plan_tier).toBe("pro");
  }
});

test("v1 getUser reports missing users", () => {
  expect(getUser("nope")).toEqual({ ok: false, error: "user_not_found" });
});

test("v1 listProjects returns raw projects for the owner", () => {
  const response = listProjects("u1");
  expect(response.ok).toBe(true);
  if (response.ok) {
    expect(response.data.map((p) => p.id)).toEqual(["p1", "p2", "p3"]);
    expect(response.data[1].is_archived).toBe(true);
  }
});

test("v1 listProjects reports missing owners", () => {
  expect(listProjects("nope")).toEqual({ ok: false, error: "user_not_found" });
});
