import type { User } from "../users/types";

/**
 * Greeting-line builder shared by every outbound notification. Produces
 * the first line of welcome emails and digests, e.g.
 * "Good morning, Ada!".
 */

export function salutationFor(utcHour: number): string {
  if (utcHour < 0 || utcHour > 23) {
    throw new Error(`salutationFor: hour out of range: ${utcHour}`);
  }
  if (utcHour < 5) return "Hello";
  if (utcHour < 12) return "Good morning";
  if (utcHour < 18) return "Good afternoon";
  return "Good evening";
}

/**
 * Builds the personalized greeting line for a user at the given hour.
 */
export function buildGreeting(user: User, utcHour: number): string {
  const salutation = salutationFor(utcHour);
  const name = user.displayName;
  return `${salutation}, ${name}!`;
}

/** Shorter variant used in push-notification titles. */
export function buildShortGreeting(user: User): string {
  const name = user.displayName;
  return `Hi ${name}`;
}
