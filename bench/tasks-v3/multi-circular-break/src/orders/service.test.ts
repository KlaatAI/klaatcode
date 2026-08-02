import { test, expect } from "bun:test";
import { placeOrder, ordersForCustomer } from "./service";

test("ordersForCustomer returns the customer's order history", () => {
  expect(ordersForCustomer("c1").map((o) => o.id)).toEqual(["o1", "o2"]);
  expect(ordersForCustomer("c3")).toEqual([]);
});

test("placeOrder accepts an order within the credit limit", () => {
  const result = placeOrder("c3", 200);
  expect(result.accepted).toBe(true);
  if (result.accepted) {
    expect(result.order.customerId).toBe("c3");
    expect(result.order.amount).toBe(200);
    expect(result.remainingCredit).toBe(300);
  }
});

test("placeOrder accepts an order exactly at the credit limit", () => {
  const result = placeOrder("c1", 300);
  expect(result.accepted).toBe(true);
  if (result.accepted) {
    expect(result.remainingCredit).toBe(0);
  }
});

test("placeOrder rejects an order over the credit limit", () => {
  expect(placeOrder("c1", 400)).toEqual({
    accepted: false,
    reason: "credit_limit_exceeded",
  });
});

test("placeOrder rejects unknown customers", () => {
  expect(placeOrder("ghost", 10)).toEqual({
    accepted: false,
    reason: "unknown_customer",
  });
});
