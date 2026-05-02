/**
 * PresetPromotionTracker — dwell-based auto-promotion (PRESETSPEC §
 * « Mémorisation »). Memorises a configuration as a preset once it has
 * held still long enough since the last gesture commit, gated by:
 *   • InGesture       (orbit-ui knows: pointer drag in flight)
 *   • OverlayActive   (orbit-ui knows: calque is open)
 *   • Suspended       (host-driven: audio not playing, effect bypassed)
 *
 * The tracker is pure state + decision logic. The host (OrbitUI) drives it:
 * `recordCommit` after each gesture, `evaluate` periodically, and the
 * three gate setters from the corresponding signals.
 */
import { computeConfigHashSync } from './orbit-hash.js';
import type { Preset } from './orbit-types.js';

export const DEFAULT_DWELL_SECONDS = 3;

export type PromotionResult =
  | { promoted: false }
  | { promoted: true; preset: Preset };

export class PresetPromotionTracker {
  private readonly dwellMs: number;
  private lastCommitAt: number | null = null;
  private lastPromotedConfigHash: string | null = null;
  private suspended: boolean = false;
  private inGesture: boolean = false;
  private overlayActive: boolean = false;

  constructor(dwellSeconds: number = DEFAULT_DWELL_SECONDS) {
    this.dwellMs = Math.max(0, dwellSeconds) * 1000;
  }

  recordCommit(now: number = Date.now()): void {
    this.lastCommitAt = now;
    this.lastPromotedConfigHash = null;
  }

  reset(): void {
    this.lastCommitAt = null;
    this.lastPromotedConfigHash = null;
  }

  setInGesture(active: boolean): void { this.inGesture = active; }
  setOverlayActive(active: boolean): void { this.overlayActive = active; }
  setSuspended(suspended: boolean): void { this.suspended = suspended; }

  isArmed(): boolean { return this.lastCommitAt !== null; }

  /**
   * Decide whether to promote. Caller passes the current configuration;
   * the tracker computes its hash, checks the dwell + gate conditions, and
   * returns either `{ promoted: false }` or a fully-formed Preset record
   * (anonymous — the host can re-key against an existing entry to preserve
   * `name` when the same configHash already exists in the library).
   */
  evaluate(
    uiHash: string,
    configuration: Readonly<Record<string, number>>,
    now: number = Date.now(),
  ): PromotionResult {
    if (this.lastCommitAt === null) return { promoted: false };
    if (now - this.lastCommitAt < this.dwellMs) return { promoted: false };
    if (this.suspended || this.inGesture || this.overlayActive) {
      return { promoted: false };
    }
    const configHash = computeConfigHashSync(configuration);
    if (this.lastPromotedConfigHash === configHash) {
      return { promoted: false };
    }
    this.lastPromotedConfigHash = configHash;
    return {
      promoted: true,
      preset: {
        uiHash,
        configHash,
        lastSeenAt: now,
        configuration: { ...configuration },
      },
    };
  }
}
