/**
 * Pure timing primitive and interpolation helpers for the continuous
 * configuration glides described in PRESETSPEC.md §"Transitions
 * dynamiques". Used by cursor arrow nav (`←`/`→`) and (later) the loop
 * mode. The timer carries no audio / config knowledge — only
 * `(startTime, durationMs)` and a linear time ratio α ∈ [0, 1].
 */

export class TransitionTimer {
  private startTime: number | null = null;
  private durationMs: number = 0;

  start(durationMs: number, now: number = Date.now()): void {
    this.startTime = now;
    this.durationMs = Math.max(0, durationMs);
  }

  /** `null` when inactive, else clamp(0, 1, (now - startTime) / duration). */
  alpha(now: number = Date.now()): number | null {
    if (this.startTime === null) return null;
    if (this.durationMs <= 0) return 1;
    const t = (now - this.startTime) / this.durationMs;
    return Math.max(0, Math.min(1, t));
  }

  isActive(now: number = Date.now()): boolean {
    if (this.startTime === null) return false;
    if (this.durationMs <= 0) return false;
    return now < this.startTime + this.durationMs;
  }

  stop(): void {
    this.startTime = null;
  }
}

/** Per-parameter linear blend; result covers exactly `addresses`. */
export function lerpConfig(
  start: Readonly<Record<string, number>>,
  target: Readonly<Record<string, number>>,
  alpha: number,
  addresses: ReadonlyArray<string>,
): Record<string, number> {
  const result: Record<string, number> = {};
  for (const address of addresses) {
    const s = start[address] ?? 0;
    const t = target[address] ?? 0;
    result[address] = s + (t - s) * alpha;
  }
  return result;
}

/** Component-wise linear interpolation between two 2D centres. */
export function lerpCenter(
  start: readonly [number, number],
  target: readonly [number, number],
  alpha: number,
): readonly [number, number] {
  return [
    start[0] + (target[0] - start[0]) * alpha,
    start[1] + (target[1] - start[1]) * alpha,
  ];
}
