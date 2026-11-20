// A small download queue: a few at a time, each photo once, newest request first (what is on screen
// now matters more than what was on screen a moment ago).
export class MediaQueue {
  private waiting: string[] = [];
  private running = 0;
  private listeners = new Set<(id: string, path: string) => void>();
  private failed = new Map<string, number>();

  constructor(
    private readonly work: (id: string) => Promise<string>,
    private readonly concurrency = 4,
    private readonly now: () => number = Date.now,
    private readonly retryAfterMs = 60_000,
  ) {}

  request(id: string): void {
    const at = this.failed.get(id);
    if (at !== undefined && this.now() - at < this.retryAfterMs) return;
    if (this.waiting.includes(id)) return;
    this.waiting.push(id);
    this.pump();
  }

  /** Photos that left the screen before their turn are dropped. */
  cancel(id: string): void {
    this.waiting = this.waiting.filter((x) => x !== id);
  }

  subscribe(fn: (id: string, path: string) => void): () => void {
    this.listeners.add(fn);
    return () => void this.listeners.delete(fn);
  }

  private pump(): void {
    while (this.running < this.concurrency && this.waiting.length) {
      const id = this.waiting.pop()!;
      this.running++;
      void this.work(id)
        .then((path) => this.listeners.forEach((l) => l(id, path)))
        .catch(() => this.failed.set(id, this.now()))
        .finally(() => {
          this.running--;
          this.pump();
        });
    }
  }
}
