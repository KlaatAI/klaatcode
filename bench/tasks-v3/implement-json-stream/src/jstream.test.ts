import { test, expect } from "bun:test";
import { JsonValueScanner } from "./jstream";

const doc =
  ' {"a":[1,2,{"b":"x\\"y"}]}\n"he\\\\llo wo rld"\t-12.5e2 true false null [true,[null,{"k":[]}]] "" 0 ';

const expected: unknown[] = [
  { a: [1, 2, { b: 'x"y' }] },
  "he\\llo wo rld",
  -1250,
  true,
  false,
  null,
  [true, [null, { k: [] }]],
  "",
  0,
];

test("parses a whole document fed in one chunk", () => {
  const s = new JsonValueScanner();
  const got = s.feed(doc);
  s.end();
  expect(got).toEqual(expected);
});

test("produces identical results for every possible split point", () => {
  for (let i = 0; i <= doc.length; i++) {
    const s = new JsonValueScanner();
    const got = [...s.feed(doc.slice(0, i)), ...s.feed(doc.slice(i))];
    s.end();
    expect(got).toEqual(expected);
  }
});

test("produces identical results fed one character at a time", () => {
  const s = new JsonValueScanner();
  const got: unknown[] = [];
  for (const ch of doc) got.push(...s.feed(ch));
  s.end();
  expect(got).toEqual(expected);
});

test("number end is only known at a delimiter", () => {
  const s = new JsonValueScanner();
  expect(s.feed("12")).toEqual([]);
  expect(s.feed("3 ")).toEqual([123]);
});

test("number split across three chunks", () => {
  const s = new JsonValueScanner();
  expect(s.feed("4")).toEqual([]);
  expect(s.feed("2")).toEqual([]);
  expect(s.feed(".5 7 ")).toEqual([42.5, 7]);
});

test("string with escaped quote split right after the backslash", () => {
  const s = new JsonValueScanner();
  expect(s.feed('"a\\')).toEqual([]);
  expect(s.feed('"b"')).toEqual(['a"b']);
});

test("string with escaped backslash split between the two backslashes", () => {
  const s = new JsonValueScanner();
  expect(s.feed('"x\\')).toEqual([]);
  expect(s.feed('\\" ')).toEqual(["x\\"]);
});

test("literals split across chunks", () => {
  const s = new JsonValueScanner();
  expect(s.feed("tr")).toEqual([]);
  expect(s.feed("ue nul")).toEqual([true]);
  expect(s.feed("l fal")).toEqual([null]);
  expect(s.feed("se ")).toEqual([false]);
});

test("brackets inside nested strings do not confuse depth tracking", () => {
  const s = new JsonValueScanner();
  expect(s.feed('{"a":"}{')).toEqual([]);
  expect(s.feed(']["}')).toEqual([{ a: "}{][" }]);
});

test("self-delimiting values complete without trailing whitespace", () => {
  const s = new JsonValueScanner();
  expect(s.feed('"abc"')).toEqual(["abc"]);
  expect(s.feed("[1,2]")).toEqual([[1, 2]]);
  expect(() => s.end()).not.toThrow();
});

test("whitespace-only and empty chunks return empty arrays", () => {
  const s = new JsonValueScanner();
  expect(s.feed("")).toEqual([]);
  expect(s.feed("  \n\t ")).toEqual([]);
  expect(s.feed("1")).toEqual([]);
  expect(s.feed("")).toEqual([]);
  expect(s.feed(" ")).toEqual([1]);
  expect(() => s.end()).not.toThrow();
});

test("end() throws on an unterminated string", () => {
  const s = new JsonValueScanner();
  s.feed('"abc');
  expect(() => s.end()).toThrow();
});

test("end() throws on an unbalanced container", () => {
  const s = new JsonValueScanner();
  s.feed("[1,2,{");
  expect(() => s.end()).toThrow();
});

test("end() throws on a number not yet terminated by whitespace", () => {
  const s = new JsonValueScanner();
  s.feed("42");
  expect(() => s.end()).toThrow();
});

test("end() throws on a partial literal", () => {
  const s = new JsonValueScanner();
  s.feed("tru");
  expect(() => s.end()).toThrow();
});

test("end() does not throw after complete whitespace-terminated values", () => {
  const s = new JsonValueScanner();
  expect(s.feed("1 2 3 ")).toEqual([1, 2, 3]);
  expect(() => s.end()).not.toThrow();
});
