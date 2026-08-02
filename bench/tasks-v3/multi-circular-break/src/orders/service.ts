// Order service: placing an order checks the customer's credit limit.
// Depends on the customers module for credit limits.
import { creditLimitFor } from "../customers/service";
import { SEED_ORDERS } from "./data";
import { Order, PlaceOrderResult } from "../shared/types";

// Credit limits are precomputed into a registry at module load so placeOrder
// does a plain lookup on the hot path.
export const CREDIT_REGISTRY: Record<string, number> = Object.fromEntries(
  ["c1", "c2", "c3"].map((id) => [id, creditLimitFor(id)]),
);

export const ordersForCustomer = (customerId: string): Order[] =>
  SEED_ORDERS.filter((order) => order.customerId === customerId);

let nextOrderId = SEED_ORDERS.length + 1;

export function placeOrder(customerId: string, amount: number): PlaceOrderResult {
  const limit = CREDIT_REGISTRY[customerId];
  if (limit === undefined) return { accepted: false, reason: "unknown_customer" };
  const outstanding = ordersForCustomer(customerId).reduce((sum, order) => sum + order.amount, 0);
  if (outstanding + amount > limit) {
    return { accepted: false, reason: "credit_limit_exceeded" };
  }
  const order: Order = { id: `o${nextOrderId++}`, customerId, amount };
  return { accepted: true, order, remainingCredit: limit - outstanding - amount };
}
