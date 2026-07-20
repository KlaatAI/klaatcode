import { describe, expect, test, beforeEach, afterEach } from "bun:test";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { expandSkill, formatSkillLocation, loadSkills, parseSkillFile } from "./loader.js";

describe("parseSkillFile", () => {
  test("parses YAML frontmatter", () => {
    const raw = `---
name: demo
description: Demo skill
args: [path]
---
Body text`;
    const { meta, body } = parseSkillFile(raw);
    expect(meta["name"]).toBe("demo");
    expect(meta["description"]).toBe("Demo skill");
    expect(meta["args"]).toBe("path");
    expect(body).toBe("Body text");
  });
});

describe("loadSkills", () => {
  let projectRoot = "";
  let homeDir = "";

  beforeEach(() => {
    projectRoot = mkdtempSync(join(tmpdir(), "klaat-skills-project-"));
    homeDir = mkdtempSync(join(tmpdir(), "klaat-skills-home-"));
  });

  afterEach(() => {
    rmSync(projectRoot, { recursive: true, force: true });
    rmSync(homeDir, { recursive: true, force: true });
  });

  test("discovers Claude project skill from SKILL.md", () => {
    const skillDir = join(projectRoot, ".claude", "skills", "foo");
    mkdirSync(skillDir, { recursive: true });
    writeFileSync(
      join(skillDir, "SKILL.md"),
      `---
name: foo
description: Claude-format skill
---
Do the foo task for $ARGUMENTS`,
    );

    const skills = loadSkills({ projectRoot, homeDir });
    expect(skills).toHaveLength(1);
    expect(skills[0]!.name).toBe("foo");
    expect(skills[0]!.origin).toBe("claude");
    expect(skills[0]!.sourceLabel).toBe(".claude/skills");
    expect(formatSkillLocation(skills[0]!)).toBe("project · .claude/skills");
  });

  test("discovers Claude global skill from ~/.claude/skills", () => {
    const skillDir = join(homeDir, ".claude", "skills", "bar");
    mkdirSync(skillDir, { recursive: true });
    writeFileSync(
      join(skillDir, "SKILL.md"),
      "---\nname: bar\ndescription: global claude skill\n---\nGlobal body",
    );

    const skills = loadSkills({ projectRoot, homeDir });
    expect(skills).toHaveLength(1);
    expect(skills[0]!.name).toBe("bar");
    expect(formatSkillLocation(skills[0]!)).toBe("global · ~/.claude/skills");
  });

  test("native KlaatCode skill wins on name collision", () => {
    const claudeDir = join(projectRoot, ".claude", "skills", "shared");
    mkdirSync(claudeDir, { recursive: true });
    writeFileSync(
      join(claudeDir, "SKILL.md"),
      "---\nname: shared\ndescription: imported\n---\nClaude body",
    );

    const nativeDir = join(projectRoot, ".klaatai", "skills");
    mkdirSync(nativeDir, { recursive: true });
    writeFileSync(
      join(nativeDir, "shared.md"),
      "---\nname: shared\ndescription: native\n---\nNative body",
    );

    const skills = loadSkills({ projectRoot, homeDir });
    expect(skills).toHaveLength(1);
    expect(skills[0]!.origin).toBe("klaatai");
    expect(skills[0]!.content).toBe("Native body");
    expect(skills[0]!.sourceLabel).toBe(".klaatai/skills");
  });

  test("skips Claude roots when importClaudeSkills is false", () => {
    const skillDir = join(projectRoot, ".claude", "skills", "only-claude");
    mkdirSync(skillDir, { recursive: true });
    writeFileSync(join(skillDir, "SKILL.md"), "---\nname: only-claude\n---\nBody");

    const skills = loadSkills({ projectRoot, homeDir, importClaudeSkills: false });
    expect(skills).toHaveLength(0);
  });
});

describe("expandSkill", () => {
  test("replaces $ARGUMENTS placeholder", () => {
    const skill = {
      name: "x",
      path: "/tmp/x.md",
      content: "Fix $ARGUMENTS now",
      scope: "project" as const,
      origin: "klaatai" as const,
      sourceLabel: ".klaatai/skills",
    };
    expect(expandSkill(skill, "src/")).toBe("Fix src/ now");
  });
});
