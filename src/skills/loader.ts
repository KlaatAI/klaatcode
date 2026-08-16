import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { homedir } from "node:os";
import { parseSkillMd, gitRootAbove } from "../agent/skills.js";

export type SkillOrigin = "klaatai" | "claude";

export interface Skill {
  name: string;
  path: string;
  content: string;
  scope: "project" | "global";
  origin: SkillOrigin;
  /** Human-readable source root shown in /skill list. */
  sourceLabel: string;
  description?: string;
  argsHint?: string;
}

export interface SkillLoadOptions {
  projectRoot: string;
  homeDir?: string;
  /** When false, skip ~/.claude/skills and .claude/skills. Default: true. */
  importClaudeSkills?: boolean;
}

export function parseSkillFile(raw: string): { meta: Record<string, string>; body: string } {
  const m = /^---\r?\n([\s\S]*?)\r?\n---\r?\n?/.exec(raw);
  if (!m) return { meta: {}, body: raw.trim() };
  const meta: Record<string, string> = {};
  for (const line of m[1]!.split("\n")) {
    const kv = /^([\w-]+):\s*(.*)$/.exec(line.trim());
    if (kv) meta[kv[1]!.toLowerCase()] = kv[2]!.trim().replace(/^["'\[]|["'\]]$/g, "");
  }
  return { meta, body: raw.slice(m[0].length).trim() };
}

function skillFromFile(
  p: string,
  fallbackName: string,
  scope: "project" | "global",
  origin: SkillOrigin,
  sourceLabel: string,
): Skill | null {
  try {
    const raw = readFileSync(p, "utf-8");
    const { meta, body } = parseSkillFile(raw);
    // Name/description via the M2 parser — it handles YAML block scalars
    // (`description: >`), the shape shared skill repos use.
    const parsed = parseSkillMd(raw, fallbackName);
    return {
      name: parsed.name || fallbackName,
      path: p,
      content: body,
      scope,
      origin,
      sourceLabel,
      description: parsed.description || undefined,
      argsHint: meta["args"],
    };
  } catch {
    return null;
  }
}

function loadFlatMdSkills(
  dir: string,
  scope: "project" | "global",
  sourceLabel: string,
): Skill[] {
  const skills: Skill[] = [];
  if (!existsSync(dir)) return skills;
  try {
    for (const f of readdirSync(dir)) {
      if (!f.endsWith(".md")) continue;
      const skill = skillFromFile(
        join(dir, f),
        f.replace(/\.md$/, ""),
        scope,
        "klaatai",
        sourceLabel,
      );
      if (skill) skills.push(skill);
    }
  } catch { /* skip unreadable dir */ }
  return skills;
}

function loadSkillMdDirs(
  dir: string,
  scope: "project" | "global",
  sourceLabel: string,
  origin: SkillOrigin = "claude",
): Skill[] {
  const skills: Skill[] = [];
  if (!existsSync(dir)) return skills;
  try {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      if (!entry.isDirectory()) continue;
      const p = join(dir, entry.name, "SKILL.md");
      if (!existsSync(p)) continue;
      const skill = skillFromFile(p, entry.name, scope, origin, sourceLabel);
      if (skill) skills.push(skill);
    }
  } catch { /* skip unreadable dir */ }
  return skills;
}

/** Expand a skill body with invocation arguments ($ARGUMENTS placeholder). */
export function expandSkill(skill: Skill, args: string): string {
  if (skill.content.includes("$ARGUMENTS")) {
    return skill.content.replaceAll("$ARGUMENTS", args || "(none)");
  }
  return args ? `${skill.content}\n\nArguments: ${args}` : skill.content;
}

export function formatSkillLocation(skill: Skill): string {
  return `${skill.scope} · ${skill.sourceLabel}`;
}

/**
 * Discover skills from KlaatCode, the cross-agent ecosystem, and (optionally)
 * Claude Code directories. Lower-priority sources are loaded first; native
 * KlaatCode skills win name collisions.
 */
export function loadSkills(opts: SkillLoadOptions): Skill[] {
  const home = opts.homeDir ?? homedir();
  const importClaude = opts.importClaudeSkills !== false;
  const byName = new Map<string, Skill>();

  const add = (skills: Skill[]) => {
    for (const s of skills) byName.set(s.name, s);
  };

  // Launching in a subfolder must still see the repo's skills — scan the git
  // root too (later adds win, so the closer projectRoot copy shadows it).
  const roots: Array<{ dir: string; label: (rel: string) => string }> = [];
  const gitRoot = gitRootAbove(opts.projectRoot);
  if (gitRoot) roots.push({ dir: gitRoot, label: rel => `${rel} (git root)` });
  roots.push({ dir: opts.projectRoot, label: rel => rel });

  if (importClaude) {
    add(loadSkillMdDirs(join(home, ".claude", "skills"), "global", "~/.claude/skills"));
    for (const r of roots) add(loadSkillMdDirs(join(r.dir, ".claude", "skills"), "project", r.label(".claude/skills")));
  }
  // M2b: cross-agent ecosystem dirs — `npx skills add <repo>` installs to
  // .agents/skills, so /caveman-style invocation works for shared skill repos.
  add(loadSkillMdDirs(join(home, ".agents", "skills"), "global", "~/.agents/skills"));
  for (const r of roots) {
    add(loadSkillMdDirs(join(r.dir, ".cursor", "skills"), "project", r.label(".cursor/skills")));
    add(loadSkillMdDirs(join(r.dir, ".klaatcode", "skills"), "project", r.label(".klaatcode/skills")));
    add(loadSkillMdDirs(join(r.dir, ".agents", "skills"), "project", r.label(".agents/skills")));
  }
  // Native KlaatCode locations — dir-based SKILL.md and flat .md both work.
  add(loadSkillMdDirs(join(home, ".klaatai", "skills"), "global", "~/.klaatai/skills", "klaatai"));
  add(loadFlatMdSkills(join(home, ".klaatai", "skills"), "global", "~/.klaatai/skills"));
  for (const r of roots) {
    add(loadSkillMdDirs(join(r.dir, ".klaatai", "skills"), "project", r.label(".klaatai/skills"), "klaatai"));
    add(loadFlatMdSkills(join(r.dir, ".klaatai", "skills"), "project", r.label(".klaatai/skills")));
  }

  return [...byName.values()].sort((a, b) => a.name.localeCompare(b.name));
}
