export interface Statement {
  credits: number;
  debits: number;
  net: number;
}

/** Convert a decimal currency amount (max two decimals) to integer minor units. */
const toMinor = (amount: number): number => Math.round(amount * 100);

/** Convert integer minor units back to decimal currency units. */
const toMajor = (minor: number): number => minor / 100;

/**
 * A small account ledger. Amounts are decimal currency units (e.g. dollars)
 * with at most two decimal places. Positive postings are credits, negative
 * postings are debits; balances and statement totals must be exact — a
 * customer statement can never be off by a cent, no matter how many
 * transactions were posted.
 *
 * All bookkeeping is done in integer minor units (cents), rounded once at
 * ingestion, so floating-point error can never accumulate.
 */
export class Ledger {
  #balances = new Map<string, number>(); // minor units
  #credits = new Map<string, number>(); // minor units
  #debits = new Map<string, number>(); // minor units

  post(account: string, amount: number): void {
    const minor = toMinor(amount);
    this.#balances.set(account, (this.#balances.get(account) ?? 0) + minor);
    if (minor >= 0) {
      this.#credits.set(account, (this.#credits.get(account) ?? 0) + minor);
    } else {
      this.#debits.set(account, (this.#debits.get(account) ?? 0) - minor);
    }
  }

  transfer(from: string, to: string, amount: number): void {
    this.post(from, -amount);
    this.post(to, amount);
  }

  balance(account: string): number {
    return toMajor(this.#balances.get(account) ?? 0);
  }

  /** Sum of every account balance. */
  total(): number {
    let sum = 0;
    for (const value of this.#balances.values()) sum += value;
    return toMajor(sum);
  }

  statement(account: string): Statement {
    const credits = this.#credits.get(account) ?? 0;
    const debits = this.#debits.get(account) ?? 0;
    return {
      credits: toMajor(credits),
      debits: toMajor(debits),
      net: toMajor(credits - debits),
    };
  }
}
