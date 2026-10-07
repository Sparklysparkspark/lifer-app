// Decides when a long run of API calls should give up because the service keeps refusing:
// once at least `threshold` of the last `window` attempts were rate-limited. A plain "N refusals
// in a row" rule never fires when the refusals are interleaved with successes, and each refusal
// still costs its retries.
export class RateLimitBreaker {
  private readonly recent: boolean[] = [];

  constructor(
    private readonly window = 40,
    private readonly threshold = 0.5,
  ) {}

  /** Records one attempt; returns true once the run should stop. */
  record(rateLimited: boolean): boolean {
    this.recent.push(rateLimited);
    if (this.recent.length > this.window) this.recent.shift();
    if (this.recent.length < this.window) return false;
    return this.recent.filter(Boolean).length >= this.threshold * this.window;
  }
}
