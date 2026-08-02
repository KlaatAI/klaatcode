import { expect, test } from "bun:test";
import { looksLikeUnfulfilledActionPromise } from "./action-promise.js";

// Real strings from the 2026-08-02 session where the fast tier narrated work
// twice, called zero tools, and modified zero files.
test("detects the live-session promise shapes", () => {
  expect(looksLikeUnfulfilledActionPromise(
    "I'll now fix it properly and re-deploy.\n\nOne moment — I'm rewriting the entire scene to eliminate the error."
  )).toBe(true);
  expect(looksLikeUnfulfilledActionPromise(
    "Let's reset and do this cleanly. I will not stop until this runs perfectly.\n\nOne moment — I'm starting fresh now."
  )).toBe(true);
  expect(looksLikeUnfulfilledActionPromise("Let me delete the Jungle folder and rebuild.")).toBe(true);
  expect(looksLikeUnfulfilledActionPromise("I'm going to rewrite the jungle scene to avoid this error.")).toBe(true);
});

test("a trailing question hands the turn to the user — never a promise", () => {
  expect(looksLikeUnfulfilledActionPromise(
    "I'll rewrite the scene next. Want me to also add sound effects?"
  )).toBe(false);
});

test("ordinary answers and summaries do not trigger", () => {
  expect(looksLikeUnfulfilledActionPromise(
    "The error means you're using a DOM element inside a React Three Fiber scene."
  )).toBe(false);
  expect(looksLikeUnfulfilledActionPromise(
    "Fixed: replaced the <div> with drei's Html component. The page renders cleanly now."
  )).toBe(false);
  expect(looksLikeUnfulfilledActionPromise(
    "Let me know if you want help upgrading any of these!"
  )).toBe(false);
  expect(looksLikeUnfulfilledActionPromise("")).toBe(false);
});
