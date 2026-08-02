import { UserStore } from "../users/store";
import { SettingsService } from "../users/settings";
import type { Clock } from "../shared/clock";
import { utcHour } from "../shared/clock";
import { buildGreeting, buildShortGreeting } from "./greeting";
import { renderTemplate, TEMPLATES } from "./templates";

export interface DigestItem {
  title: string;
  url: string;
}

export interface ComposedMessage {
  to: string;
  subject: string;
  body: string;
}

/**
 * Composes outbound notification messages. Pure string assembly — actual
 * delivery is out of scope for this service. The first body line is
 * always the personalized greeting from src/notifications/greeting.ts.
 */
export class NotificationService {
  constructor(
    private readonly store: UserStore,
    private readonly settings: SettingsService,
    private readonly clock: Clock,
  ) {}

  /** Welcome message sent right after signup. */
  composeWelcome(userId: string): ComposedMessage {
    const user = this.store.get(userId);
    if (user.status !== "active") {
      throw new Error(`cannot compose welcome for ${user.status} user ${userId}`);
    }
    const greeting = buildGreeting(user, utcHour(this.clock));
    const body = `${greeting}\n\n${TEMPLATES.welcomeBody}`;
    return {
      to: user.email,
      subject: "Welcome aboard",
      body,
    };
  }

  /**
   * Periodic digest. Returns null when the user has digests disabled
   * (frequency "never" or non-active status, per migration 0008/0006).
   */
  composeDigest(userId: string, items: DigestItem[]): ComposedMessage | null {
    if (!this.settings.digestEnabled(userId)) return null;
    const user = this.store.get(userId);
    const prefs = this.settings.getSettings(userId);
    const greeting = buildGreeting(user, utcHour(this.clock));
    const lines: string[] = [greeting, ""];
    lines.push(renderTemplate(TEMPLATES.digestHeader, { frequency: prefs.digestFrequency }));
    for (const item of items) {
      lines.push(renderTemplate(TEMPLATES.digestItem, { title: item.title }));
    }
    lines.push("", TEMPLATES.digestFooter);
    return {
      to: user.email,
      subject: `Your ${prefs.digestFrequency} digest`,
      body: lines.join("\n"),
    };
  }

  /** Title string for a mobile push notification. */
  pushTitle(userId: string): string {
    const user = this.store.get(userId);
    return buildShortGreeting(user);
  }
}
