/**
 * M2 — skills with progressive disclosure.
 *
 * A skill is a directory holding a SKILL.md playbook — a reusable procedure
 * the user has taught the agent ("how we deploy", "how we write migrations").
 * Discovery order (earlier locations win on a name clash):
 *
 *   <project>/.klaatai/skills/<name>/SKILL.md   — our canonical project location
 *   <project>/.agents/skills/<name>/SKILL.md    — the cross-agent "universal" dir
 *       (`npx skills add <repo>` installs here — open-source skill repos work
 *       out of the box without KlaatCode being in that tool's agent list)
 *   <project>/.klaatcode/skills/, .cursor/skills/ — compat locations
 *   ~/.klaatai/skills/, ~/.agents/skills/       — global (shared with VS Code)
 *
 * Progressive disclosure (prime-agent's shape, same finding as G6): ONLY the
 * name + one-line description of each skill enters the system prompt (~20
 * tokens per skill, byte-stable for the whole session → prefix-cache-safe);
 * the model reads the full SKILL.md with read_file when a task matches. The
 * index is the cached prefix; the bodies are deferred.
 *
 * SKILL.md format (Anthropic's emerging standard):
 *
 *   ---
 *   name: deploy-gateway
 *   description: How to deploy the Klaatu gateway to Render
 *   ---
 *   ...full playbook body, read on demand...
 *
 * Fallback when frontmatter is absent: directory name as the name, first
 * heading or paragraph line as the description.
 */

import { readFileSync, readdirSync, existsSync } from "node:fs";
import { join, resolve } from "node:path";
import { homedir } from "node:os";
import { execSync } from "node:child_process";

export const SKILL_FILE = "SKILL.md";
/** Keep the index small — it rides in every request's prompt head. */
export const MAX_SKILLS = 30;
const MAX_DESCRIPTION_CHARS = 150;
const MAX_NAME_CHARS = 60;

export interface SkillMeta {
  name: string;
  description: string;
  /** Absolute path to the SKILL.md — what the model passes to read_file. */
  path: string;
  source: "project" | "global";
}

export function globalSkillsDir(): string {
  return join(homedir(), ".klaatai", "skills");
}

/** Canonical location — /skills new scaffolds here. */
export function projectSkillsDir(projectRoot: string): string {
  return join(projectRoot, ".klaatai", "skills");
}

/** All project-relative dirs scanned, canonical first (wins on clash). */
const PROJECT_SKILL_DIRS = [
  join(".klaatai", "skills"),
  join(".agents", "skills"),
  join(".klaatcode", "skills"),
  join(".cursor", "skills"),
];

/** Parse a SKILL.md's identity: frontmatter name/description, with directory
 *  name + first heading/paragraph as fallback. Exported for tests. */
export function parseSkillMd(content: string, dirName: string): { name: string; description: string } {
  let name = dirName;
  let description = "";
  const fm = /^---\r?\n([\s\S]*?)\r?\n---/.exec(content);
  let body = content;
  if (fm) {
    body = content.slice(fm[0].length);
    const lines = fm[1]!.split(/\r?\n/);
    for (let i = 0; i < lines.length; i++) {
      const m = /^(name|description)\s*:\s*(.*)$/.exec(lines[i]!);
      if (!m) continue;
      let value = m[2]!.trim();
      // YAML block scalar (`description: >` / `|`) — common in shared skill
      // repos: the value is the following indented lines, joined.
      if (value === "" || /^[>|][+-]?$/.test(value)) {
        const parts: string[] = [];
        while (i + 1 < lines.length && /^\s+\S/.test(lines[i + 1]!)) parts.push(lines[++i]!.trim());
        value = parts.join(" ");
      }
      if (m[1] === "name") { if (value) name = value; }
      else if (value) description = value;
    }
  }
  if (!description) {
    // First heading, else first non-empty line of the body.
    for (const line of body.split(/\r?\n/)) {
      const t = line.trim();
      if (!t) continue;
      description = t.replace(/^#+\s*/, "");
      break;
    }
  }
  return {
    name: name.slice(0, MAX_NAME_CHARS),
    description: description.slice(0, MAX_DESCRIPTION_CHARS),
  };
}

function scanDir(dir: string, source: SkillMeta["source"]): SkillMeta[] {
  const out: SkillMeta[] = [];
  try {
    if (!existsSync(dir)) return out;
    for (const e of readdirSync(dir, { withFileTypes: true })) {
      // Both shapes count: <dir>/<name>/SKILL.md and flat <dir>/<name>.md
      // (the /skill new template) — the slash loader sees both, so the
      // prompt index must too.
      let mdPath: string;
      let fallbackName: string;
      if (e.isDirectory()) {
        mdPath = join(dir, e.name, SKILL_FILE);
        fallbackName = e.name;
      } else if (e.isFile() && e.name.endsWith(".md") && e.name.toLowerCase() !== "readme.md") {
        mdPath = join(dir, e.name);
        fallbackName = e.name.replace(/\.md$/, "");
      } else {
        continue;
      }
      try {
        if (!existsSync(mdPath)) continue;
        const content = readFileSync(mdPath, "utf-8");
        if (!content.trim()) continue;
        const { name, description } = parseSkillMd(content, fallbackName);
        out.push({ name, description, path: mdPath, source });
      } catch { /* unreadable skill — skip */ }
    }
  } catch { /* unreadable dir — no skills */ }
  return out.sort((a, b) => a.name.localeCompare(b.name));
}

/** Git toplevel of a dir when it differs from the dir itself — launching the
 *  CLI in a subfolder must still see the repo's skills. Cached per process. */
const _gitRootCache = new Map<string, string | null>();
export function gitRootAbove(dir: string): string | null {
  const key = resolve(dir);
  const hit = _gitRootCache.get(key);
  if (hit !== undefined) return hit;
  let root: string | null = null;
  try {
    const out = execSync("git rev-parse --show-toplevel", {
      cwd: dir, encoding: "utf-8", stdio: ["ignore", "pipe", "ignore"], timeout: 2000,
    }).trim();
    if (out) root = resolve(out); // git prints forward slashes on Windows
    if (root === key) root = null; // already at the root — nothing extra
  } catch { /* not a repo */ }
  _gitRootCache.set(key, root);
  return root;
}

/** All skills visible from this project. Earlier locations shadow later ones
 *  on a name clash (project dir → git root → global).
 *  `homeDir` is injectable for tests — real callers omit it. */
export function discoverSkills(projectRoot: string, homeDir?: string): SkillMeta[] {
  const home = homeDir ?? homedir();
  const byName = new Set<string>();
  const all: SkillMeta[] = [];
  const take = (list: SkillMeta[]) => {
    for (const s of list) {
      if (byName.has(s.name)) continue;
      byName.add(s.name);
      all.push(s);
    }
  };
  for (const rel of PROJECT_SKILL_DIRS) take(scanDir(join(projectRoot, rel), "project"));
  const gitRoot = gitRootAbove(projectRoot);
  if (gitRoot) for (const rel of PROJECT_SKILL_DIRS) take(scanDir(join(gitRoot, rel), "project"));
  take(scanDir(join(home, ".klaatai", "skills"), "global"));
  take(scanDir(join(home, ".agents", "skills"), "global"));
  return all.slice(0, MAX_SKILLS);
}

/** The system-prompt index block. Loaded ONCE at session start — never
 *  re-read mid-session (prefix-cache stability). Null when no skills exist. */
export function skillsSystemBlock(projectRoot: string, homeDir?: string): string | null {
  const skills = discoverSkills(projectRoot, homeDir);
  if (skills.length === 0) return null;
  const lines = skills.map(s => `- ${s.name} — ${s.description}\n  playbook: ${s.path}`);
  return [
    "# Skills — reusable procedures this user has installed",
    "Each skill is a playbook for a task the user does repeatedly. Only this index is loaded. " +
    "When the current task matches a skill's description, read_file its playbook FIRST and follow it — " +
    "it encodes how THIS user wants that task done, and overrides your defaults. " +
    "Ignore skills that don't match the task at hand.",
    lines.join("\n"),
  ].join("\n\n");
}
