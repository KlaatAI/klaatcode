/**
 * Deterministic id generation. No randomness: ids are a prefixed,
 * zero-padded counter so fixtures and tests are stable run to run.
 */
export class IdGenerator {
  private counter = 0;

  constructor(private readonly prefix: string, private readonly width = 4) {}

  next(): string {
    this.counter += 1;
    return `${this.prefix}_${String(this.counter).padStart(this.width, "0")}`;
  }

  /** Number of ids handed out so far. */
  issued(): number {
    return this.counter;
  }
}

export function isValidId(prefix: string, id: string): boolean {
  const re = new RegExp(`^${prefix}_\\d{4,}$`);
  return re.test(id);
}
