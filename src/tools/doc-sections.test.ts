import { describe, test, expect } from "bun:test";
import { extractDocSections } from "./doc-sections.js";

const DOC = `# KlaatAI

An AI coding assistant.

## Install

\`\`\`sh
# this hash line is a comment, not a heading
npm i -g klaatcode
\`\`\`

## Usage

Run \`klaatcode\` in a project.

### Flags

--model forces a tier.

# Appendix

Licensing notes.
`;

describe("extractDocSections", () => {
  test("headings become section symbols with correct spans", () => {
    const secs = extractDocSections(DOC, "README.md");
    expect(secs.map((s) => s.name)).toEqual(["KlaatAI", "Install", "Usage", "Flags", "Appendix"]);
    for (const s of secs) expect(s.kind).toBe("section");

    const title = secs[0]!;
    expect(title.start_line).toBe(1);
    // "# KlaatAI" runs until the next same-level heading ("# Appendix", line 20).
    expect(title.end_line).toBe(19);

    const usage = secs.find((s) => s.name === "Usage")!;
    const flags = secs.find((s) => s.name === "Flags")!;
    // "Flags" is nested INSIDE "Usage": spans overlap, Usage ends before Appendix.
    expect(flags.start_line).toBeGreaterThan(usage.start_line);
    expect(usage.end_line).toBeGreaterThanOrEqual(flags.end_line);
  });

  test("hash lines inside fenced code blocks are not headings", () => {
    const secs = extractDocSections(DOC, "README.md");
    expect(secs.some((s) => s.name.includes("comment"))).toBe(false);
  });

  test("signature carries the heading plus the first content line", () => {
    const secs = extractDocSections(DOC, "README.md");
    expect(secs[0]!.signature).toBe("# KlaatAI — An AI coding assistant.");
    expect(secs.find((s) => s.name === "Usage")!.signature)
      .toBe("## Usage — Run `klaatcode` in a project.");
  });

  test("levels 1-2 are exported, deeper levels are not", () => {
    const secs = extractDocSections(DOC, "README.md");
    expect(secs.find((s) => s.name === "Install")!.is_exported).toBe(true);
    expect(secs.find((s) => s.name === "Flags")!.is_exported).toBe(false);
  });

  test("a heading-less doc yields one whole-file section named after the file", () => {
    const secs = extractDocSections("Just some notes.\nMore notes.\n", "NOTES.md");
    expect(secs).toHaveLength(1);
    expect(secs[0]!.name).toBe("NOTES.md");
    expect(secs[0]!.start_line).toBe(1);
    expect(secs[0]!.is_exported).toBe(true);
  });

  test("an empty file yields nothing", () => {
    expect(extractDocSections("\n\n", "empty.md")).toHaveLength(0);
  });

  test("trailing closing hashes are stripped (setext-style '## Title ##')", () => {
    const secs = extractDocSections("## Title ##\n\nBody.\n", "x.md");
    expect(secs[0]!.name).toBe("Title");
  });
});
