import { promises as fs } from "node:fs";
import * as path from "node:path";
import type { IdempotencyStore, PaymentPayload, SpendQuery, SpendRecord, SpendTracker } from "../types.js";

async function readJsonFile<T>(filePath: string, fallback: T): Promise<T> {
  try {
    const raw = await fs.readFile(filePath, "utf-8");
    if (!raw.trim()) return fallback;
    return JSON.parse(raw) as T;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return fallback;
    throw error;
  }
}

async function writeJsonFileAtomic(filePath: string, data: unknown): Promise<void> {
  const dir = path.dirname(filePath);
  await fs.mkdir(dir, { recursive: true });
  // Write to a temp file and rename into place so a crash mid-write never
  // leaves the backing file half-written/corrupt.
  const tmpPath = path.join(dir, `.${path.basename(filePath)}.${process.pid}.${Date.now()}.tmp`);
  await fs.writeFile(tmpPath, JSON.stringify(data, null, 2), "utf-8");
  await fs.rename(tmpPath, filePath);
}

/**
 * Serializes a sequence of async operations run against the same backing
 * file so concurrent calls on ONE instance don't race on a
 * read-modify-write and clobber each other. Scoped per-process — this does
 * NOT provide cross-process file locking; two processes writing the same
 * file concurrently can still race (last writer wins).
 */
class Mutex {
  private tail: Promise<unknown> = Promise.resolve();

  run<T>(fn: () => Promise<T>): Promise<T> {
    const result = this.tail.then(fn, fn);
    this.tail = result.then(
      () => undefined,
      () => undefined
    );
    return result;
  }
}

function filterRecords(records: SpendRecord[], query: SpendQuery): SpendRecord[] {
  const asOf = query.asOf ?? Date.now();
  const cutoff = query.windowMs !== undefined ? asOf - query.windowMs : undefined;

  return records.filter((record) => {
    if (query.resource !== undefined && record.resource !== query.resource) return false;
    if (query.provider !== undefined && record.provider !== query.provider) return false;
    if (record.timestamp > asOf) return false;
    if (cutoff !== undefined && record.timestamp < cutoff) return false;
    return true;
  });
}

/**
 * `SpendTracker` backed by a JSON file on disk, so recorded spend survives
 * process restarts — unlike `InMemorySpendTracker`. Built only on Node's
 * `node:fs/promises`; no new dependency.
 *
 * Concurrent calls on the SAME instance are serialized safely via an
 * internal mutex. This is NOT a multi-process-safe store — for spend
 * tracked across multiple processes, back `SpendTracker` with a real
 * database (Redis/Postgres/etc.) instead.
 */
export class FileSpendTracker implements SpendTracker {
  private readonly filePath: string;
  private readonly mutex = new Mutex();

  constructor(filePath: string) {
    this.filePath = filePath;
  }

  async recordSpend(record: SpendRecord): Promise<void> {
    await this.mutex.run(async () => {
      const records = await readJsonFile<SpendRecord[]>(this.filePath, []);
      records.push(record);
      await writeJsonFileAtomic(this.filePath, records);
    });
  }

  async getTotalSpend(query: SpendQuery = {}): Promise<string> {
    const records = await this.getRecords(query);
    const total = records.reduce((sum, record) => sum + BigInt(record.amount), 0n);
    return total.toString();
  }

  async getRecords(query: SpendQuery = {}): Promise<SpendRecord[]> {
    const records = await this.mutex.run(() => readJsonFile<SpendRecord[]>(this.filePath, []));
    return filterRecords(records, query);
  }

  /** Removes all recorded spend, resetting the backing file to an empty list. */
  async clear(): Promise<void> {
    await this.mutex.run(() => writeJsonFileAtomic(this.filePath, []));
  }
}

/**
 * `IdempotencyStore` backed by a JSON file on disk, so cached payment
 * payloads survive process restarts — unlike `InMemoryIdempotencyStore`.
 * Same concurrency caveat as `FileSpendTracker`: safe within one process,
 * not across processes.
 */
export class FileIdempotencyStore implements IdempotencyStore {
  private readonly filePath: string;
  private readonly mutex = new Mutex();

  constructor(filePath: string) {
    this.filePath = filePath;
  }

  async get(key: string): Promise<PaymentPayload | undefined> {
    const store = await this.mutex.run(() => readJsonFile<Record<string, PaymentPayload>>(this.filePath, {}));
    return store[key];
  }

  async set(key: string, payload: PaymentPayload): Promise<void> {
    await this.mutex.run(async () => {
      const store = await readJsonFile<Record<string, PaymentPayload>>(this.filePath, {});
      store[key] = payload;
      await writeJsonFileAtomic(this.filePath, store);
    });
  }

  async has(key: string): Promise<boolean> {
    const store = await this.mutex.run(() => readJsonFile<Record<string, PaymentPayload>>(this.filePath, {}));
    return Object.prototype.hasOwnProperty.call(store, key);
  }

  /** Removes all cached payment payloads, resetting the backing file to an empty object. */
  async clear(): Promise<void> {
    await this.mutex.run(() => writeJsonFileAtomic(this.filePath, {}));
  }
}
