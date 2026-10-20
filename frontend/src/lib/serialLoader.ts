// SerialLoader: runs async loads strictly one at a time, keeps the last good
// value for an item when its reload fails (and records the failure), and
// discards any result that is older than a newer ticket for the same key.

import { MonotonicClock } from "./clock";

export interface ItemState<V> {
  value?: V;
  /** Message of the most recent failed attempt, cleared by the next success. */
  error?: string;
  /** Clock tick of the request whose value is currently held. */
  loadedAt?: number;
  /** Clock tick of the most recent failure. */
  failedAt?: number;
  /** True while `value` predates a failed refresh. */
  stale: boolean;
}

export type LoaderListener = () => void;

export class SerialLoader<V> {
  private items = new Map<string, ItemState<V>>();
  private latestTicket = new Map<string, number>();
  private chain: Promise<unknown> = Promise.resolve();
  private listeners = new Set<LoaderListener>();
  private epoch = 0;
  private inflight = 0;

  constructor(
    private readonly fetcher: (key: string) => Promise<V>,
    readonly clock: MonotonicClock = new MonotonicClock(),
  ) {}

  subscribe(fn: LoaderListener): () => void {
    this.listeners.add(fn);
    return () => this.listeners.delete(fn);
  }

  private emit(): void {
    for (const fn of this.listeners) fn();
  }

  get(key: string): ItemState<V> {
    return this.items.get(key) ?? { stale: false };
  }

  keys(): string[] {
    return [...this.items.keys()];
  }

  get busy(): boolean {
    return this.inflight > 0;
  }

  /** Keys whose latest attempt failed. */
  failedKeys(): string[] {
    return [...this.items.entries()].filter(([, s]) => s.error !== undefined).map(([k]) => k);
  }

  /** Queue a load; resolves with the item's state once its turn has run. */
  load(key: string): Promise<ItemState<V>> {
    const ticket = this.clock.next();
    this.latestTicket.set(key, ticket);
    const epochAtQueue = this.epoch;
    this.inflight += 1;
    const run = this.chain.then(async () => {
      try {
        // A clear() or a newer request for this key makes this run pointless.
        if (epochAtQueue !== this.epoch) return this.get(key);
        if ((this.latestTicket.get(key) ?? 0) > ticket) return this.get(key);
        try {
          const value = await this.fetcher(key);
          if (epochAtQueue !== this.epoch || (this.latestTicket.get(key) ?? 0) > ticket) {
            return this.get(key);
          }
          this.items.set(key, { value, loadedAt: ticket, stale: false });
        } catch (e) {
          if (epochAtQueue !== this.epoch) return this.get(key);
          const prev = this.items.get(key);
          this.items.set(key, {
            value: prev?.value,
            loadedAt: prev?.loadedAt,
            error: e instanceof Error ? e.message : String(e),
            failedAt: ticket,
            stale: prev?.value !== undefined,
          });
        }
        this.emit();
        return this.get(key);
      } finally {
        this.inflight -= 1;
      }
    });
    this.chain = run.catch(() => undefined);
    return run;
  }

  /** Load several keys in order, one after another. */
  async loadAll(keys: string[]): Promise<Record<string, ItemState<V>>> {
    const out: Record<string, ItemState<V>> = {};
    for (const k of keys) out[k] = await this.load(k);
    return out;
  }

  /** Drop everything (account switch). In-flight loads started before this are ignored. */
  clear(): void {
    this.epoch += 1;
    this.items.clear();
    this.latestTicket.clear();
    this.emit();
  }
}
