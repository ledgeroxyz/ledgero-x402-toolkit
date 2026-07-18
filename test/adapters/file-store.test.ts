import { promises as fs } from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { FileIdempotencyStore, FileSpendTracker } from "../../src/adapters/file-store.js";
import type { PaymentPayload, SpendRecord } from "../../src/index.js";

let tmpDir: string;

beforeEach(async () => {
  tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "x402-toolkit-file-store-"));
});

afterEach(async () => {
  await fs.rm(tmpDir, { recursive: true, force: true });
});

function makeRecord(overrides: Partial<SpendRecord> = {}): SpendRecord {
  return {
    resource: "https://api.example/v1/lookup",
    amount: "1000",
    asset: "0xUsdc",
    network: "base-sepolia",
    timestamp: Date.now(),
    ...overrides,
  };
}

describe("FileSpendTracker", () => {
  it("persists recorded spend to disk and reads it back", async () => {
    const filePath = path.join(tmpDir, "spend.json");
    const tracker = new FileSpendTracker(filePath);

    await tracker.recordSpend(makeRecord({ resource: "a", amount: "100" }));
    await tracker.recordSpend(makeRecord({ resource: "a", amount: "250" }));
    await tracker.recordSpend(makeRecord({ resource: "b", amount: "999" }));

    expect(await tracker.getTotalSpend({ resource: "a" })).toBe("350");
    expect(await tracker.getTotalSpend()).toBe("1349");

    const raw = await fs.readFile(filePath, "utf-8");
    const persisted = JSON.parse(raw) as SpendRecord[];
    expect(persisted).toHaveLength(3);
  });

  it("survives a fresh instance pointed at the same file (simulated process restart)", async () => {
    const filePath = path.join(tmpDir, "spend.json");
    const first = new FileSpendTracker(filePath);
    await first.recordSpend(makeRecord({ resource: "a", amount: "500" }));

    const second = new FileSpendTracker(filePath);
    expect(await second.getTotalSpend({ resource: "a" })).toBe("500");

    await second.recordSpend(makeRecord({ resource: "a", amount: "500" }));
    expect(await first.getTotalSpend({ resource: "a" })).toBe("1000");
  });

  it("returns zero total spend when the backing file does not exist yet", async () => {
    const tracker = new FileSpendTracker(path.join(tmpDir, "does-not-exist.json"));
    expect(await tracker.getTotalSpend()).toBe("0");
    expect(await tracker.getRecords()).toEqual([]);
  });

  it("respects windowMs filtering, like InMemorySpendTracker", async () => {
    const tracker = new FileSpendTracker(path.join(tmpDir, "spend.json"));
    const now = Date.now();
    await tracker.recordSpend(makeRecord({ resource: "a", amount: "100", timestamp: now - 100_000 }));
    await tracker.recordSpend(makeRecord({ resource: "a", amount: "200", timestamp: now - 1_000 }));

    const total = await tracker.getTotalSpend({ resource: "a", windowMs: 5_000, asOf: now });
    expect(total).toBe("200");
  });

  it("clear() resets recorded spend", async () => {
    const tracker = new FileSpendTracker(path.join(tmpDir, "spend.json"));
    await tracker.recordSpend(makeRecord());
    await tracker.clear();
    expect(await tracker.getTotalSpend()).toBe("0");
  });

  it("serializes concurrent recordSpend calls without losing writes", async () => {
    const tracker = new FileSpendTracker(path.join(tmpDir, "spend.json"));
    await Promise.all(
      Array.from({ length: 20 }, (_, i) => tracker.recordSpend(makeRecord({ resource: "a", amount: String(i + 1) })))
    );

    // Sum 1..20 = 210 — every concurrent write must have been applied, none lost to a race.
    expect(await tracker.getTotalSpend({ resource: "a" })).toBe("210");
    expect(await tracker.getRecords({ resource: "a" })).toHaveLength(20);
  });
});

describe("FileIdempotencyStore", () => {
  const payload: PaymentPayload = {
    x402Version: 1,
    scheme: "exact",
    network: "base-sepolia",
    payload: { signature: "0xdeadbeef" },
  };

  it("persists a stored payment payload to disk and reads it back", async () => {
    const filePath = path.join(tmpDir, "idempotency.json");
    const store = new FileIdempotencyStore(filePath);

    expect(await store.get("k")).toBeUndefined();
    expect(await store.has("k")).toBe(false);

    await store.set("k", payload);

    expect(await store.has("k")).toBe(true);
    expect(await store.get("k")).toEqual(payload);

    const raw = await fs.readFile(filePath, "utf-8");
    expect(JSON.parse(raw)).toEqual({ k: payload });
  });

  it("survives a fresh instance pointed at the same file (simulated process restart)", async () => {
    const filePath = path.join(tmpDir, "idempotency.json");
    const first = new FileIdempotencyStore(filePath);
    await first.set("assessment-1", payload);

    const second = new FileIdempotencyStore(filePath);
    expect(await second.get("assessment-1")).toEqual(payload);
  });

  it("returns undefined when the backing file does not exist yet", async () => {
    const store = new FileIdempotencyStore(path.join(tmpDir, "does-not-exist.json"));
    expect(await store.get("k")).toBeUndefined();
    expect(await store.has("k")).toBe(false);
  });

  it("clear() removes all cached payloads", async () => {
    const store = new FileIdempotencyStore(path.join(tmpDir, "idempotency.json"));
    await store.set("k", payload);
    await store.clear();
    expect(await store.get("k")).toBeUndefined();
  });

  it("serializes concurrent set() calls for different keys without losing writes", async () => {
    const store = new FileIdempotencyStore(path.join(tmpDir, "idempotency.json"));
    await Promise.all(
      Array.from({ length: 20 }, (_, i) => store.set(`key-${i}`, { ...payload, payload: { i } }))
    );

    for (let i = 0; i < 20; i++) {
      expect(await store.has(`key-${i}`)).toBe(true);
    }
  });
});
