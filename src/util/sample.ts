/**
 * Lets the first event per key per window through and counts the rest, so a
 * flood of refused requests (429s) writes one usage row per caller per minute
 * instead of one per request. The counts go to the log when a window closes.
 * Bounded: at most `max` keys are tracked.
 */
export class EventSampler {
  private readonly seen = new Map<string, { until: number; suppressed: number }>();

  constructor(
    private readonly onSuppressed: (key: string, count: number) => void,
    private readonly windowMs = 60_000,
    private readonly max = 10_000,
  ) {}

  take(key: string, now: number): boolean {
    const e = this.seen.get(key);
    if (e && e.until > now) {
      e.suppressed++;
      return false;
    }
    if (e?.suppressed) this.onSuppressed(key, e.suppressed);
    if (!e && this.seen.size >= this.max) this.sweep(now);
    this.seen.set(key, { until: now + this.windowMs, suppressed: 0 });
    return true;
  }

  get size(): number {
    return this.seen.size;
  }

  private sweep(now: number) {
    for (const [k, e] of this.seen) {
      if (e.until > now) continue;
      if (e.suppressed) this.onSuppressed(k, e.suppressed);
      this.seen.delete(k);
    }
    if (this.seen.size < this.max) return;
    // Still full of live windows (many callers at once): report and start over.
    let total = 0;
    for (const e of this.seen.values()) total += e.suppressed;
    if (total) this.onSuppressed("(many callers)", total);
    this.seen.clear();
  }
}
