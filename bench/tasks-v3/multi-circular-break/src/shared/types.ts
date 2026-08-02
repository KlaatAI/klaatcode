export interface Order {
  id: string;
  customerId: string;
  amount: number;
}

export interface Customer {
  id: string;
  name: string;
}

export type LoyaltyTier = "bronze" | "silver" | "gold";

export type PlaceOrderResult =
  | { accepted: true; order: Order; remainingCredit: number }
  | { accepted: false; reason: "unknown_customer" | "credit_limit_exceeded" };
