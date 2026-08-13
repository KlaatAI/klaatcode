import { test, expect } from "bun:test";
import { UserStore } from "./store";
import { ProfileService } from "./profile";
import { SettingsService } from "./settings";
import { AuditLog } from "./audit";
import { NotificationService } from "../notifications/service";
import { SearchIndexer } from "../search/indexer";
import { searchIds } from "../search/query";
import { serializeUser, deserializeUser } from "../serialization/json";
import { usersToCsv } from "../serialization/csv";
import { FixedClock } from "../shared/clock";

function makeWorld() {
  const clock = new FixedClock("2026-06-15T09:30:00.000Z"); // UTC hour 9 -> "Good morning"
  const store = new UserStore();
  const audit = new AuditLog(clock);
  const settings = new SettingsService(store, audit);
  const profiles = new ProfileService(store, clock);
  const notifications = new NotificationService(store, settings, clock);
  const indexer = new SearchIndexer(store);

  const ada = store.create({
    email: "ada@example.com",
    displayName: "Ada",
    fullName: "Ada Lovelace",
    timezone: "Europe/Berlin",
    createdAt: "2025-03-10T12:00:00.000Z",
  });
  const grace = store.create({
    email: "grace@example.com",
    displayName: "Grace H.",
    fullName: "Grace Hopper",
    timezone: "America/New_York",
    createdAt: "2026-06-01T08:00:00.000Z",
  });
  indexer.reindexAll();
  return { clock, store, audit, settings, profiles, notifications, indexer, ada, grace };
}

test("profile view renders the canonical display name", () => {
  const { profiles, ada } = makeWorld();
  const view = profiles.renderProfile(ada.id);
  expect(view.heading).toBe("Ada");
  expect(view.subtitle).toBe("Ada Lovelace · en-US");
  expect(view.memberSince).toBe("Member since March 2025");
});

test("JSON serialization round-trips and carries no legacy field", () => {
  const { ada } = makeWorld();
  const json = serializeUser(ada);
  expect(json).toContain('"display_name":"Ada"');
  expect(json).not.toContain("nickname");
  expect(deserializeUser(json)).toEqual(ada);
});

test("CSV export uses the post-migration column set", () => {
  const { store } = makeWorld();
  const csv = usersToCsv(store.list());
  expect(csv.split("\n")[0]).toBe(
    "id,email,displayName,fullName,locale,timezone,createdAt,status",
  );
  expect(csv).toContain("Grace H.");
});

test("search finds users by display name", () => {
  const { indexer, ada, grace } = makeWorld();
  expect(searchIds(indexer, "ada")).toEqual([ada.id]);
  expect(searchIds(indexer, "grace")).toEqual([grace.id]);
});

test("settings updates persist and are audited", () => {
  const { settings, audit, ada } = makeWorld();
  const updated = settings.updateSettings(ada.id, { theme: "dark", digestFrequency: "daily" });
  expect(updated.theme).toBe("dark");
  expect(audit.countByAction("settings.update")).toBe(1);
});

test("welcome message greets the user by display name", () => {
  const { notifications, ada } = makeWorld();
  const message = notifications.composeWelcome(ada.id);
  expect(message.to).toBe("ada@example.com");
  expect(message.body.split("\n")[0]).toBe("Good morning, Ada!");
  expect(message.body).not.toContain("undefined");
});

test("digest greeting line uses the display name too", () => {
  const { notifications, grace } = makeWorld();
  const digest = notifications.composeDigest(grace.id, [
    { title: "Weekly changelog", url: "https://example.com/changelog" },
  ]);
  expect(digest).not.toBeNull();
  expect(digest!.body.startsWith("Good morning, Grace H.!")).toBe(true);
  expect(digest!.body).toContain("  - Weekly changelog");
});

test("push title greets by display name", () => {
  const { notifications, grace } = makeWorld();
  expect(notifications.pushTitle(grace.id)).toBe("Hi Grace H.");
});

test("digest is suppressed when frequency is never", () => {
  const { notifications, settings, ada } = makeWorld();
  settings.updateSettings(ada.id, { digestFrequency: "never" });
  expect(notifications.composeDigest(ada.id, [])).toBeNull();
});
