/**
 * Minimal mustache-style template rendering used for notification bodies.
 * `{{name}}` placeholders are replaced from the vars map; unknown
 * placeholders throw so template drift is caught early.
 */
export class TemplateError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "TemplateError";
  }
}

const PLACEHOLDER_RE = /\{\{\s*([a-zA-Z][a-zA-Z0-9_.]*)\s*\}\}/g;

export function renderTemplate(template: string, vars: Record<string, string>): string {
  return template.replace(PLACEHOLDER_RE, (_m, key: string) => {
    if (!(key in vars)) {
      throw new TemplateError(`missing template variable: ${key}`);
    }
    return vars[key]!;
  });
}

/** Lists the placeholder names a template references, in order, unique. */
export function templateVariables(template: string): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const match of template.matchAll(PLACEHOLDER_RE)) {
    const key = match[1]!;
    if (!seen.has(key)) {
      seen.add(key);
      out.push(key);
    }
  }
  return out;
}

/** Bundled template bodies. Name variables use `displayName` (migration 0007). */
export const TEMPLATES = {
  welcomeBody:
    "Your account is ready. Explore your dashboard to get started.\n" +
    "You can change your preferences at any time in Settings.",
  digestHeader: "Here is your {{frequency}} digest:",
  digestItem: "  - {{title}}",
  digestFooter: "Manage digest settings from your profile page.",
} as const;
