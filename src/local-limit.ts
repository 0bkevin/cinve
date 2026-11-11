/**
 * Fixed-window counters kept in this process's memory. They are only a cheap
 * first filter that drops floods before any database work; the authoritative,
 * cross-instance limits stay in Postgres (ConnectionLinks.budget).
 *
 * Memory is bounded by capacity. Windows all have the same length and a new
 * window is always inserted last, so Map order is expiry order: eviction
 * pops expired windows from the front (amortized O(1)), then the oldest live
 * ones if a key flood still fills the map. Evicting a live window only
 * forgets a count, which the Postgres limits still enforce.
 */
export class LocalLimiter {
  private windows = new Map<string, { count: number; resets: number }>();
  constructor(private readonly limit: number, private readonly windowMs = 60000, private readonly capacity = 10000,
    private readonly now: () => number = Date.now) {}
  private live(key: string) {
    const window = this.windows.get(key);
    return window && window.resets > this.now() ? window : undefined;
  }
  /** True when the key has used its whole limit in the current window. Counts nothing. */
  exhausted(key: string) { return (this.live(key)?.count ?? 0) >= this.limit; }
  /** Counts one event; false once the key is over its limit. */
  hit(key: string) {
    let window = this.live(key);
    if (!window) {
      const now = this.now();
      this.windows.delete(key);
      for (const [k, w] of this.windows) { if (w.resets > now) break; this.windows.delete(k); }
      while (this.windows.size >= this.capacity) this.windows.delete(this.windows.keys().next().value!);
      window = { count: 0, resets: now + this.windowMs };
      this.windows.set(key, window);
    }
    window.count = Math.min(window.count + 1, this.limit + 1);
    return window.count <= this.limit;
  }
  get size() { return this.windows.size; }
}
