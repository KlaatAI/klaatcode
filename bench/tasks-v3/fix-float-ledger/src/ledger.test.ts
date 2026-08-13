import { test, expect } from "bun:test";
import { Ledger } from "./ledger";

test("a thousand postings of 0.10 sum to exactly 100", () => {
  const l = new Ledger();
  for (let i = 0; i < 1000; i++) l.post("acct", 0.1);
  expect(l.balance("acct")).toBe(100);
});

test("a hundred cents make exactly one dollar", () => {
  const l = new Ledger();
  for (let i = 0; i < 100; i++) l.post("a", 0.01);
  expect(l.balance("a")).toBe(1);
});

test("offsetting postings cancel to exactly zero", () => {
  const l = new Ledger();
  for (let i = 0; i < 100; i++) {
    l.post("a", 0.1);
    l.post("a", 0.2);
    l.post("a", -0.3);
  }
  expect(l.balance("a")).toBe(0);
});

test("repeated transfers preserve both balances and the combined total exactly", () => {
  const l = new Ledger();
  l.post("checking", 10);
  for (let i = 0; i < 30; i++) l.transfer("checking", "savings", 0.1);
  expect(l.balance("savings")).toBe(3);
  expect(l.balance("checking")).toBe(7);
  expect(l.total()).toBe(10);
});

test("statement totals are exact and net matches the balance", () => {
  const l = new Ledger();
  for (let i = 0; i < 10; i++) {
    l.post("a", 1.1);
    l.post("a", -0.55);
  }
  const s = l.statement("a");
  expect(s.credits).toBe(11);
  expect(s.debits).toBe(5.5);
  expect(s.net).toBe(5.5);
  expect(l.balance("a")).toBe(5.5);
});

test("many small mixed postings across accounts keep every total exact", () => {
  const l = new Ledger();
  for (let i = 0; i < 500; i++) {
    l.post("a", 0.03);
    l.post("b", 0.07);
  }
  expect(l.balance("a")).toBe(15);
  expect(l.balance("b")).toBe(35);
  expect(l.total()).toBe(50);
});

test("balances can go negative and stay exact", () => {
  const l = new Ledger();
  for (let i = 0; i < 3; i++) l.post("x", -0.1);
  expect(l.balance("x")).toBe(-0.3);
  const s = l.statement("x");
  expect(s.credits).toBe(0);
  expect(s.debits).toBe(0.3);
  expect(s.net).toBe(-0.3);
});

test("unknown accounts read as zero", () => {
  const l = new Ledger();
  expect(l.balance("ghost")).toBe(0);
  expect(l.statement("ghost")).toEqual({ credits: 0, debits: 0, net: 0 });
  expect(l.total()).toBe(0);
});
