import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { homedir } from "node:os";

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
    const { meta, body } = parseSkillFile(readFileSync(p, "utf-8"));
    return {
      name: meta["name"] || fallbackName,
      path: p,
      content: body,
      scope,
      origin,
      sourceLabel,
      description: meta["description"],
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

function loadClaudeSkillDir(
  dir: string,
  scope: "project" | "global",
  sourceLabel: string,
): Skill[] {
  const skills: Skill[] = [];
  if (!existsSync(dir)) return skills;
  try {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      if (!entry.isDirectory()) continue;
      const skill = skillFromFile(
        join(dir, entry.name, "SKILL.md"),
        entry.name,
        scope,
        "claude",
        sourceLabel,
      );
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
 * Discover skills from KlaatCode and (optionally) Claude Code directories.
 * Lower-priority sources are loaded first; native KlaatCode skills win name collisions.
 */
export function loadSkills(opts: SkillLoadOptions): Skill[] {
  const home = opts.homeDir ?? homedir();
  const importClaude = opts.importClaudeSkills !== false;
  const byName = new Map<string, Skill>();

  const add = (skills: Skill[]) => {
    for (const s of skills) byName.set(s.name, s);
  };

  if (importClaude) {
    add(loadClaudeSkillDir(join(home, ".claude", "skills"), "global", "~/.claude/skills"));
    add(loadClaudeSkillDir(join(opts.projectRoot, ".claude", "skills"), "project", ".claude/skills"));
  }
  add(loadFlatMdSkills(join(home, ".klaatai", "skills"), "global", "~/.klaatai/skills"));
  add(loadFlatMdSkills(join(opts.projectRoot, ".klaatai", "skills"), "project", ".klaatai/skills"));

  return [...byName.values()].sort((a, b) => a.name.localeCompare(b.name));
}
