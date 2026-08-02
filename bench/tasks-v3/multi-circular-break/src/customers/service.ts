// Customer service: loyalty tiers derive from order history, credit limits
// derive from loyalty tier. Depends on the orders module for order history.
import { ordersForCustomer } from "../orders/service";
import { CUSTOMERS } from "./data";
import { Customer, LoyaltyTier } from "../shared/types";

export const findCustomer = (id: string): Customer | undefined =>
  CUSTOMERS.find((customer) => customer.id === id);

export const loyaltyTierFor = (customerId: string): LoyaltyTier => {
  const total = ordersForCustomer(customerId).reduce((sum, order) => sum + order.amount, 0);
  if (total >= 1000) return "gold";
  if (total >= 200) return "silver";
  return "bronze";
};

const BASE_CREDIT = 500;

const TIER_MULTIPLIER: Record<LoyaltyTier, number> = {
  bronze: 1,
  silver: 2,
  gold: 3,
};

export function creditLimitFor(customerId: string): number {
  return BASE_CREDIT * TIER_MULTIPLIER[loyaltyTierFor(customerId)];
}
