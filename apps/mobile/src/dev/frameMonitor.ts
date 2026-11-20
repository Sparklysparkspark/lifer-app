// Development only: counts JS stalls as gaps between animation frames. A frame should come every
// 16 ms; a gap over 50 ms is a stall the person could see as a frozen spinner.
export interface Stall {
  at: number;
  ms: number;
  phase: string;
}

export class FrameMonitor {
  readonly stalls: Stall[] = [];
  phase = "";
  private running = false;
  private last = 0;
  private frames = 0;
  private started = 0;

  start(): void {
    if (this.running) return;
    this.running = true;
    this.started = this.last = Date.now();
    const tick = () => {
      if (!this.running) return;
      const now = Date.now();
      const gap = now - this.last;
      this.last = now;
      this.frames++;
      if (gap > 50) this.stalls.push({ at: now - this.started, ms: gap, phase: this.phase });
      requestAnimationFrame(tick);
    };
    requestAnimationFrame(tick);
  }

  stop(): { frames: number; longest: number; over50: number; worst: Stall[]; byPhase: Record<string, number> } {
    this.running = false;
    const byPhase: Record<string, number> = {};
    for (const s of this.stalls) byPhase[s.phase] = Math.max(byPhase[s.phase] ?? 0, s.ms);
    const worst = [...this.stalls].sort((a, b) => b.ms - a.ms).slice(0, 12);
    return { frames: this.frames, longest: worst[0]?.ms ?? 0, over50: this.stalls.length, worst, byPhase };
  }
}
