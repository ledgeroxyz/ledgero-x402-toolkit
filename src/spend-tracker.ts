import type { SpendQuery, SpendRecord, SpendTracker } from "./types.js";

/**
 * Default `SpendTracker`: keeps records in a plain array in memory. Fine for
 * a single-process agent or for tests; for multi-process/durable deployments
 * implement `SpendTracker` against Redis/Postgres/etc. instead.
 */
export class InMemorySpendTracker implements SpendTracker {
  private records: SpendRecord[] = [];

  recordSpend(record: SpendRecord): void {
    this.records.push(record);
  }

  getTotalSpend(query: SpendQuery = {}): string {
    const total = this.filter(query).reduce((sum, record) => sum + BigInt(record.amount), 0n);
    return total.toString();
  }

  getRecords(query: SpendQuery = {}): SpendRecord[] {
    return this.filter(query);
  }

  /** Removes all recorded spend. Mainly useful in tests. */
  clear(): void {
    this.records = [];
  }

  private filter(query: SpendQuery): SpendRecord[] {
    const asOf = query.asOf ?? Date.now();
    const cutoff = query.windowMs !== undefined ? asOf - query.windowMs : undefined;

    return this.records.filter((record) => {
      if (query.resource !== undefined && record.resource !== query.resource) return false;
      if (query.provider !== undefined && record.provider !== query.provider) return false;
      if (record.timestamp > asOf) return false;
      if (cutoff !== undefined && record.timestamp < cutoff) return false;
      return true;
    });
  }
}
