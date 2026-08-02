import { test, expect } from "bun:test";
import { globMatch } from "./glob";

test("literals and * (never crosses a slash, dot is literal)", () => {
  expect(globMatch("foo", "foo")).toBe(true);
  expect(globMatch("*.ts", "a.ts")).toBe(true);
  expect(globMatch("*.ts", ".ts")).toBe(true); // * matches empty
  expect(globMatch("*.ts", "a/b.ts")).toBe(false); // * must not cross /
  expect(globMatch("*.ts", "ats")).toBe(false); // "." is literal
});

test("? matches exactly one non-slash character", () => {
  expect(globMatch("a?c", "abc")).toBe(true);
  expect(globMatch("a?c", "ac")).toBe(false);
  expect(globMatch("a?c", "a/c")).toBe(false);
});

test("** crosses segments, including zero segments", () => {
  expect(globMatch("a/**/b", "a/b")).toBe(true); // zero segments
  expect(globMatch("a/**/b", "a/x/b")).toBe(true);
  expect(globMatch("a/**/b", "a/x/y/b")).toBe(true);
  expect(globMatch("a/**/b", "ab")).toBe(false);
  expect(globMatch("**/*.ts", "x.ts")).toBe(true);
  expect(globMatch("**/*.ts", "a/b/x.ts")).toBe(true);
  expect(globMatch("a/**", "a")).toBe(true);
  expect(globMatch("a/**", "a/b/c")).toBe(true);
  expect(globMatch("a/**", "b")).toBe(false);
});

test("{a,b} alternation, including alternatives containing slashes", () => {
  expect(globMatch("{src,lib}/**/*.js", "src/a.js")).toBe(true);
  expect(globMatch("{src,lib}/**/*.js", "lib/x/y.js")).toBe(true);
  expect(globMatch("{src,lib}/**/*.js", "test/a.js")).toBe(false);
  expect(globMatch("a/{b/c,d}/e", "a/b/c/e")).toBe(true);
  expect(globMatch("a/{b/c,d}/e", "a/d/e")).toBe(true);
  expect(globMatch("a/{b/c,d}/e", "a/b/e")).toBe(false);
});

test("character classes with ranges and ! negation", () => {
  expect(globMatch("[abc].txt", "b.txt")).toBe(true);
  expect(globMatch("[abc].txt", "d.txt")).toBe(false);
  expect(globMatch("[a-z]1", "q1")).toBe(true);
  expect(globMatch("[!0-9]x", "ax")).toBe(true);
  expect(globMatch("[!0-9]x", "3x")).toBe(false);
});
