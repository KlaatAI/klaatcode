import { describe, expect, test, beforeEach, afterEach } from "bun:test";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { parseSkillMd, discoverSkills, skillsSystemBlock, MAX_SKILLS } from "./skills.js";

let root: string;
let fakeHome: string; // isolates tests from real ~/.klaatai and ~/.agents skills

function addSkill(dir: string, name: string, content: string): void {
  const d = join(dir, name);
  mkdirSync(d, { recursive: true });
  writeFileSync(join(d, "SKILL.md"), content, "utf-8");
}

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "klaatai-skills-"));
  fakeHome = mkdtempSync(join(tmpdir(), "klaatai-skills-home-"));
});

afterEach(() => {
  rmSync(root, { recursive: true, force: true });
  rmSync(fakeHome, { recursive: true, force: true });
});

describe("parseSkillMd", () => {
  test("frontmatter name + description win", () => {
    const r = parseSkillMd("---\nname: deploy-gw\ndescription: How we deploy the gateway\n---\n\n# ignored\nbody", "dirname");
    expect(r.name).toBe("deploy-gw");
    expect(r.description).toBe("How we deploy the gateway");
  });

  test("no frontmatter falls back to dir name + first heading", () => {
    const r = parseSkillMd("# Release checklist\n\nsteps", "release");
    expect(r.name).toBe("release");
    expect(r.description).toBe("Release checklist");
  });

  test("frontmatter without description falls back to first body line", () => {
    const r = parseSkillMd("---\nname: x\n---\nAlways run migrations first.\n", "d");
    expect(r.name).toBe("x");
    expect(r.description).toBe("Always run migrations first.");
  });

  test("caps overlong fields", () => {
    const r = parseSkillMd(`---\nname: ${"n".repeat(200)}\ndescription: ${"d".repeat(400)}\n---\n`, "d");
    expect(r.name.length).toBeLessThanOrEqual(60);
    expect(r.description.length).toBeLessThanOrEqual(150);
  });

  test("YAML folded-block description (>) as used by npx-skills-add repos", () => {
    const r = parseSkillMd(
      "---\nname: caveman\ndescription: >\n  Ultra-compressed communication mode.\n  Cuts output tokens.\n---\nbody",
      "d",
    );
    expect(r.name).toBe("caveman");
    expect(r.description).toBe("Ultra-compressed communication mode. Cuts output tokens.");
  });
});

describe("discoverSkills", () => {
  test("finds project skills; ignores non-skill dirs and empty files", () => {
    const skillsDir = join(root, ".klaatai", "skills");
    addSkill(skillsDir, "alpha", "---\nname: alpha\ndescription: A\n---\nbody");
    addSkill(skillsDir, "empty", "");
    mkdirSync(join(skillsDir, "no-md"), { recursive: true });
    const found = discoverSkills(root, fakeHome);
    expect(found.map(s => s.name)).toEqual(["alpha"]);
    expect(found[0]!.source).toBe("project");
    expect(found[0]!.path.endsWith("SKILL.md")).toBe(true);
  });

  test("no skills dir yields empty, no throw", () => {
    expect(discoverSkills(root, fakeHome)).toEqual([]);
  });

  test("universal .agents/skills dir is discovered; .klaatai wins on name clash", () => {
    addSkill(join(root, ".agents", "skills"), "shared", "---\nname: shared\ndescription: from agents dir\n---\n");
    addSkill(join(root, ".agents", "skills"), "clash", "---\nname: clash\ndescription: universal version\n---\n");
    addSkill(join(root, ".klaatai", "skills"), "clash", "---\nname: clash\ndescription: canonical version\n---\n");
    const found = discoverSkills(root, fakeHome);
    expect(found.find(s => s.name === "shared")?.description).toBe("from agents dir");
    expect(found.find(s => s.name === "clash")?.description).toBe("canonical version");
  });

  test("flat .md skills (the /skill new template) appear in the index too", () => {
    const skillsDir = join(root, ".klaatai", "skills");
    mkdirSync(skillsDir, { recursive: true });
    writeFileSync(join(skillsDir, "fix-types.md"), "---\nname: fix-types\ndescription: fix TS errors\n---\nBody", "utf-8");
    writeFileSync(join(skillsDir, "README.md"), "# not a skill", "utf-8");
    const found = discoverSkills(root, fakeHome);
    expect(found.map(s => s.name)).toEqual(["fix-types"]);
  });

  test("global ~/.agents/skills is discovered", () => {
    addSkill(join(fakeHome, ".agents", "skills"), "globby", "---\nname: globby\ndescription: global universal\n---\n");
    const found = discoverSkills(root, fakeHome);
    expect(found.find(s => s.name === "globby")?.source).toBe("global");
  });

  test("caps at MAX_SKILLS", () => {
    const skillsDir = join(root, ".klaatai", "skills");
    for (let i = 0; i < MAX_SKILLS + 5; i++) {
      addSkill(skillsDir, `s${String(i).padStart(2, "0")}`, `---\nname: s${i}\ndescription: d\n---\n`);
    }
    expect(discoverSkills(root, fakeHome).length).toBe(MAX_SKILLS);
  });
});

describe("skillsSystemBlock", () => {
  test("null when nothing installed", () => {
    expect(skillsSystemBlock(root, fakeHome)).toBeNull();
  });

  test("index carries name, description, and the playbook path, never the body", () => {
    addSkill(join(root, ".klaatai", "skills"), "migrate",
      "---\nname: migrate\ndescription: How to write DB migrations here\n---\nSECRET-BODY-LINE never in prompt");
    const block = skillsSystemBlock(root, fakeHome)!;
    expect(block).toContain("migrate — How to write DB migrations here");
    expect(block).toContain("SKILL.md");
    expect(block).toContain("read_file");
    // Progressive disclosure: the body must NOT ride in the prompt head.
    expect(block).not.toContain("SECRET-BODY-LINE");
  });
});
