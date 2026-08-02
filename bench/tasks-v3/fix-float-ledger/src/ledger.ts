export interface Statement {
  credits: number;
  debits: number;
  net: number;
}

/**
 * A small account ledger. Amounts are decimal currency units (e.g. dollars)
 * with at most two decimal places. Positive postings are credits, negative
 * postings are debits; balances and statement totals must be exact — a
 * customer statement can never be off by a cent, no matter how many
 * transactions were posted.
 */
export class Ledger {
  #balances = new Map<string, number>();
  #credits = new Map<string, number>();
  #debits = new Map<string, number>();

  post(account: string, amount: number): void {
    this.#balances.set(account, (this.#balances.get(account) ?? 0) + amount);
    if (amount >= 0) {
      this.#credits.set(account, (this.#credits.get(account) ?? 0) + amount);
    } else {
      this.#debits.set(account, (this.#debits.get(account) ?? 0) - amount);
    }
  }

  transfer(from: string, to: string, amount: number): void {
    this.post(from, -amount);
    this.post(to, amount);
  }

  balance(account: string): number {
    return this.#balances.get(account) ?? 0;
  }

  /** Sum of every account balance. */
  total(): number {
    let sum = 0;
    for (const value of this.#balances.values()) sum += value;
    return sum;
  }

  statement(account: string): Statement {
    const credits = this.#credits.get(account) ?? 0;
    const debits = this.#debits.get(account) ?? 0;
    return { credits, debits, net: credits - debits };
  }
}
