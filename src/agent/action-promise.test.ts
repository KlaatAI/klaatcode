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

test("exploration promises count too — seen live 2026-08-08", () => {
  expect(looksLikeUnfulfilledActionPromise(
    "Let me read the rest of the file to see the exact content."
  )).toBe(true);
  expect(looksLikeUnfulfilledActionPromise("I'll check the current state of flappy.html.")).toBe(true);
  expect(looksLikeUnfulfilledActionPromise("Let me re-read that region first.")).toBe(true);
  // "let me know" stays a legitimate handoff, not a promise
  expect(looksLikeUnfulfilledActionPromise("Let me know when you've deployed it.")).toBe(false);
});

test("plural narrated-plan voice counts — seen live 2026-08-16", () => {
  // The turn that ended dead on this exact sentence, tools never called:
  expect(looksLikeUnfulfilledActionPromise("Let's read the file.")).toBe(true);
  expect(looksLikeUnfulfilledActionPromise(
    "We need to explain the TUI implementation. We should probably read the tui.ts file to understand its structure, exports, and usage.\n\nLet's read the file."
  )).toBe(true);
  expect(looksLikeUnfulfilledActionPromise("We'll check the auth flow next.")).toBe(true);
  // Advice about the user's own actions is not a promise
  expect(looksLikeUnfulfilledActionPromise("You should read the contributing guide.")).toBe(false);
  // A trailing question still hands off, even in plural voice
  expect(looksLikeUnfulfilledActionPromise("Let's read the file — or do you want a summary first?")).toBe(false);
});
