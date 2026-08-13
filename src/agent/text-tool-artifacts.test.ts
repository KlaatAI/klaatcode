import { expect, test } from "bun:test";
import { stripStrayTextToolCallArtifacts } from "./text-tool-artifacts.js";

test("strips a full <function=name>...</function> block with args", () => {
  const input =
    "Let me check the graph.\n" +
    "<function=project_graph_query>\n<parameter=query>foo</parameter>\n</function>";
  const out = stripStrayTextToolCallArtifacts(input);
  expect(out).not.toContain("<function");
  expect(out).not.toContain("<parameter");
  expect(out.startsWith("Let me check the graph.")).toBe(true);
});

test("strips a parameterless block (the reported bug's exact shape)", () => {
  const input =
    "Let me check your project structure to give you a quick overview.\n\n" +
    "<function=mcp_filesystemlistallowed_directories>\n</function>\n</tool_call>";
  const out = stripStrayTextToolCallArtifacts(input);
  expect(out).not.toContain("<function");
  expect(out).not.toContain("</tool_call>");
  expect(out).toContain("Let me check your project structure to give you a quick overview.");
});

test("strips the name= attribute variant", () => {
  const input = '<function name="read"><parameter name="filePath">a.ts</parameter></function>';
  expect(stripStrayTextToolCallArtifacts(input)).toBe("");
});

test("strips multiple blocks in one message", () => {
  const input =
    "<function=read_file><parameter=path>a.ts</parameter></function>\n" +
    "<function=read_file><parameter=path>b.ts</parameter></function>";
  expect(stripStrayTextToolCallArtifacts(input)).toBe("\n");
});

test("strips a stray unpaired closing tag with no matching open tag", () => {
  expect(stripStrayTextToolCallArtifacts("done\n</tool_call>")).toBe("done\n");
});

test("strips a truncated/incomplete block (open tag never closed)", () => {
  // e.g. streaming got interrupted mid tool-call — no closing </function> at all
  const input = "Working on it.\n<function=read_file>\n<parameter=path>a.ts";
  const out = stripStrayTextToolCallArtifacts(input);
  expect(out).not.toContain("<function");
  expect(out).toContain("Working on it.");
});

test("leaves ordinary text mentioning 'function' or 'tool' untouched", () => {
  const input = "This function calls another tool internally.";
  expect(stripStrayTextToolCallArtifacts(input)).toBe(input);
});

test("leaves markdown code fences with unrelated angle brackets untouched", () => {
  const input = "Use `<div>` for a container, not `<span>`.";
  expect(stripStrayTextToolCallArtifacts(input)).toBe(input);
});

test("empty string in, empty string out", () => {
  expect(stripStrayTextToolCallArtifacts("")).toBe("");
});

test("strips <klaatu_creation> wrapper tags but keeps the inner content (web-prompt leak, 2026-07-19)", () => {
  const input =
    '<klaatu_creation lang="html" title="Project Structure">\n' +
    "<pre>\nsrc/\n├── app/\n</pre>\n" +
    "</klaatu_creation>";
  const out = stripStrayTextToolCallArtifacts(input);
  expect(out).not.toContain("klaatu_creation");
  expect(out).toContain("src/");
  expect(out).toContain("├── app/");
});

// ── maskTextToolXmlForDisplay (live-stream variant) ──────────────────────────

import { maskTextToolXmlForDisplay } from "./text-tool-artifacts.js";

test("mask: holds back an in-flight tool_call block from the opener on", () => {
  const streaming =
    "Verifying the page now.\n<tool_call>\n<function=run_command>\n<parameter=command>\ncurl -f http://localhost:3000/jungle";
  const out = maskTextToolXmlForDisplay(streaming);
  expect(out).not.toContain("<tool_call");
  expect(out).not.toContain("curl -f");
  expect(out).toContain("Verifying the page now.");
});

test("mask: holds back a bare <function= opener without wrapper", () => {
  const out = maskTextToolXmlForDisplay("On it.\n<function=read_file>\n<parameter=path>a.ts");
  expect(out).toBe("On it.\n");
});

test("mask: swallows a trailing partial tag so it never flashes", () => {
  expect(maskTextToolXmlForDisplay("Done reading. <tool_c")).toBe("Done reading. ");
  expect(maskTextToolXmlForDisplay("Done reading. <func")).toBe("Done reading. ");
  expect(maskTextToolXmlForDisplay("Done reading. <")).toBe("Done reading. ");
});

test("mask: strips a completed block once its closer arrives", () => {
  const done =
    "Checking.\n<tool_call>\n<function=run_command>\n<parameter=command>ls</parameter>\n</function>\n</tool_call>\nDone.";
  const out = maskTextToolXmlForDisplay(done);
  expect(out).not.toContain("<");
  expect(out).toContain("Checking.");
  expect(out).toContain("Done.");
});

test("mask: leaves ordinary text and html mentions untouched", () => {
  const input = "Use `<div>` for a container; this function is fine.";
  expect(maskTextToolXmlForDisplay(input)).toBe(input);
});

test("mask: a lone '<f' mid-sentence that keeps streaming as normal text is not lost forever", () => {
  // Once more characters arrive and it's clearly not a holdable tag, it renders.
  expect(maskTextToolXmlForDisplay("a <b> c")).toBe("a <b> c");
  expect(maskTextToolXmlForDisplay("5 < 6 and 7 > 6")).toBe("5 < 6 and 7 > 6");
});
