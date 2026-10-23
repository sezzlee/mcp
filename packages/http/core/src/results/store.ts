import { randomBytes } from "node:crypto";

/** The defaults of the in-memory result store; packages/http/spec/result-reading.md. */
export const resultLimits = {
  lifetimeMs: 600_000,
  maxCallerBytes: 16_777_216,
  maxBytes: 67_108_864,
} as const;

/**
 * Keeps over-budget answers for `read_result`, under a caller partition and a handle the
 * implementation mints.
 */
export interface ResultStore {
  /**
   * @returns how many whole seconds the value will be kept, or `undefined` when it was not kept
   */
  put(
    partition: string,
    handle: string,
    value: string,
  ): Promise<number | undefined>;
  get(partition: string, handle: string): Promise<string | undefined>;
}

/**
 * A bound store together with the partition of the caller one meta-tool call serves.
 *
 * @param report receives a store failure, which the call answers as if no store were bound
 */
export interface ResultShelf {
  readonly store: ResultStore;
  readonly partition: string;
  readonly report?: (error: unknown) => void;
}

export const handlePattern = /^[A-Za-z0-9_-]{22}$/;

/**
 * Guard: the handle is the only thing that names a stored result, so it carries 128 bits from the
 * platform's secure source; a counter or `Math.random` would let one caller guess another's.
 */
export function mintHandle(): string {
  return randomBytes(16).toString("base64url");
}

export interface MemoryResultStoreOptions {
  readonly lifetimeMs?: number;
  readonly maxCallerBytes?: number;
  readonly maxBytes?: number;
  /**
   * Milliseconds from a clock that never goes back; `performance.now` by default.
   *
   * Guard: insertion order is expiry order only under such a clock. The wall clock moves when the
   * host's time is corrected, and a step back would leave an expired value behind a live one, where
   * the sweep stops before reaching it and the live one is evicted first.
   */
  readonly now?: () => number;
}

interface Stored {
  readonly partition: string;
  readonly handle: string;
  readonly value: string;
  readonly bytes: number;
  readonly expires: number;
}

/**
 * The per-process default store. Every value lives the same absolute lifetime, so insertion order
 * is also expiry order, and the oldest value is always the first to go.
 */
export class MemoryResultStore implements ResultStore {
  private readonly lifetimeMs: number;
  private readonly maxCallerBytes: number;
  private readonly maxBytes: number;
  private readonly now: () => number;
  private readonly order = new Set<Stored>();
  private readonly partitions = new Map<string, Map<string, Stored>>();
  private readonly partitionBytes = new Map<string, number>();
  private total = 0;

  constructor(options: MemoryResultStoreOptions = {}) {
    this.lifetimeMs = options.lifetimeMs ?? resultLimits.lifetimeMs;
    this.maxCallerBytes = options.maxCallerBytes ?? resultLimits.maxCallerBytes;
    this.maxBytes = options.maxBytes ?? resultLimits.maxBytes;
    this.now = options.now ?? (() => performance.now());
  }

  async put(
    partition: string,
    handle: string,
    value: string,
  ): Promise<number | undefined> {
    const bytes = Buffer.byteLength(value, "utf8");
    if (
      this.lifetimeMs < 1000 ||
      bytes > this.maxCallerBytes ||
      bytes > this.maxBytes
    ) {
      return undefined;
    }
    const now = this.now();
    this.dropExpired(now);
    const previous = this.partitions.get(partition)?.get(handle);
    if (previous !== undefined) {
      this.remove(previous);
    }
    while (
      (this.partitionBytes.get(partition) ?? 0) + bytes >
      this.maxCallerBytes
    ) {
      const oldest = this.partitions.get(partition)?.values().next().value;
      if (oldest === undefined) {
        break;
      }
      this.remove(oldest);
    }
    while (this.total + bytes > this.maxBytes) {
      const oldest = this.order.values().next().value;
      if (oldest === undefined) {
        break;
      }
      this.remove(oldest);
    }
    const stored: Stored = {
      partition,
      handle,
      value,
      bytes,
      expires: now + this.lifetimeMs,
    };
    let held = this.partitions.get(partition);
    if (held === undefined) {
      held = new Map();
      this.partitions.set(partition, held);
    }
    held.set(handle, stored);
    this.order.add(stored);
    this.partitionBytes.set(
      partition,
      (this.partitionBytes.get(partition) ?? 0) + bytes,
    );
    this.total += bytes;
    return Math.floor(this.lifetimeMs / 1000);
  }

  async get(partition: string, handle: string): Promise<string | undefined> {
    const stored = this.partitions.get(partition)?.get(handle);
    if (stored === undefined) {
      return undefined;
    }
    if (stored.expires <= this.now()) {
      this.remove(stored);
      return undefined;
    }
    return stored.value;
  }

  private dropExpired(now: number): void {
    for (const stored of this.order) {
      if (stored.expires > now) {
        return;
      }
      this.remove(stored);
    }
  }

  private remove(stored: Stored): void {
    this.order.delete(stored);
    const held = this.partitions.get(stored.partition);
    held?.delete(stored.handle);
    if (held?.size === 0) {
      this.partitions.delete(stored.partition);
      this.partitionBytes.delete(stored.partition);
    } else {
      this.partitionBytes.set(
        stored.partition,
        (this.partitionBytes.get(stored.partition) ?? 0) - stored.bytes,
      );
    }
    this.total -= stored.bytes;
  }
}
