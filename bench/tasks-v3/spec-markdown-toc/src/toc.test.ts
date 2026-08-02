import { test, expect } from "bun:test";
import { generateToc } from "./toc";

test("single heading", () => {
  expect(generateToc("# Hello")).toBe("- [Hello](#hello)");
});

test("nested levels with 2-space indentation", () => {
  const md = "# Alpha\nSome text.\n## Beta\n### Gamma\n## Delta";
  expect(generateToc(md)).toBe(
    "- [Alpha](#alpha)\n  - [Beta](#beta)\n    - [Gamma](#gamma)\n  - [Delta](#delta)"
  );
});

test("minDepth filters and rebases indentation", () => {
  const md = "# Alpha\n## Beta\n### Gamma\n## Delta";
  expect(generateToc(md, { minDepth: 2 })).toBe(
    "- [Beta](#beta)\n  - [Gamma](#gamma)\n- [Delta](#delta)"
  );
});

test("maxDepth filters deep headings", () => {
  const md = "# Alpha\n## Beta\n### Gamma\n## Delta";
  expect(generateToc(md, { maxDepth: 2 })).toBe(
    "- [Alpha](#alpha)\n  - [Beta](#beta)\n  - [Delta](#delta)"
  );
});

test("setext headings are ignored", () => {
  const md = "Title\n=====\nSub\n---\n# Real";
  expect(generateToc(md)).toBe("- [Real](#real)");
});

test("headings inside backtick fences are excluded (info string allowed)", () => {
  const md = "# Top\n```js\n# not a heading\n```\n# Bottom";
  expect(generateToc(md)).toBe("- [Top](#top)\n- [Bottom](#bottom)");
});

test("tilde fences also exclude headings", () => {
  const md = "~~~\n# hidden\n~~~\n# Shown";
  expect(generateToc(md)).toBe("- [Shown](#shown)");
});

test("unclosed fence runs to end of input", () => {
  const md = "# Before\n```\n# After\n# Still hidden";
  expect(generateToc(md)).toBe("- [Before](#before)");
});

test("mismatched fence character does not close a fence", () => {
  const md = "```\n~~~\n# hidden\n```\n# Visible";
  expect(generateToc(md)).toBe("- [Visible](#visible)");
});

test("seven hashes and missing space are not headings", () => {
  expect(generateToc("####### Seven\n#NoSpace")).toBe("");
});

test("hash-only headings are ignored", () => {
  expect(generateToc("#\n# #\n## ###")).toBe("");
});

test("ATX closing sequence is stripped", () => {
  expect(generateToc("## Title ##", { minDepth: 2 })).toBe("- [Title](#title)");
});

test("trailing hash without preceding space is kept", () => {
  expect(generateToc("# C#")).toBe("- [C#](#c)");
});

test("up to three leading spaces allowed, four disqualifies", () => {
  const md = "   # Indented\n    # NotHeading";
  expect(generateToc(md)).toBe("- [Indented](#indented)");
});

test("tab after hashes is a valid separator", () => {
  expect(generateToc("#\tTabbed")).toBe("- [Tabbed](#tabbed)");
});

test("punctuation is removed from slug but kept in display", () => {
  expect(generateToc("# Hello, World!")).toBe("- [Hello, World!](#hello-world)");
});

test("underscores survive slugging", () => {
  expect(generateToc("# snake_case rules")).toBe(
    "- [snake_case rules](#snake_case-rules)"
  );
});

test("each space becomes a hyphen without collapsing", () => {
  expect(generateToc("# a  b")).toBe("- [a  b](#a--b)");
});

test("duplicate slugs get -1, -2 suffixes in document order", () => {
  expect(generateToc("# Setup\n# Setup\n# Setup")).toBe(
    "- [Setup](#setup)\n- [Setup](#setup-1)\n- [Setup](#setup-2)"
  );
});

test("dedupe counts headings excluded by the depth filter", () => {
  expect(generateToc("## Install\n# Install", { maxDepth: 1 })).toBe(
    "- [Install](#install-1)"
  );
});

test("link text is kept for display and slug", () => {
  expect(generateToc("# See [the docs](https://x.dev)")).toBe(
    "- [See the docs](#see-the-docs)"
  );
});

test("image syntax keeps alt text and drops the bang", () => {
  expect(generateToc("# Logo ![icon](i.png) here")).toBe(
    "- [Logo icon here](#logo-icon-here)"
  );
});

test("inline code markers are stripped for display and slug", () => {
  expect(generateToc("# Use `npm install`")).toBe(
    "- [Use npm install](#use-npm-install)"
  );
});

test("bold markers are stripped", () => {
  expect(generateToc("# **Bold** move")).toBe("- [Bold move](#bold-move)");
});

test("empty input and heading-free input produce empty string", () => {
  expect(generateToc("")).toBe("");
  expect(generateToc("just some\nplain text")).toBe("");
});

test("empty base slug participates in dedupe", () => {
  expect(generateToc("# !!!\n# !!!")).toBe("- [!!!](#)\n- [!!!](#-1)");
});

test("invalid option ranges throw RangeError", () => {
  expect(() => generateToc("# x", { minDepth: 0 })).toThrow(RangeError);
  expect(() => generateToc("# x", { maxDepth: 7 })).toThrow(RangeError);
  expect(() => generateToc("# x", { minDepth: 3, maxDepth: 2 })).toThrow(RangeError);
});
