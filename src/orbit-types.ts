/**
 * Public data types of the OrbitUI component, mirroring ORBITDATAMODELSPEC.md.
 *
 * These types describe the shape of values exchanged with the host (preset
 * library, trajectory, selection, loop settings). They are intentionally flat
 * and JSON-serialisable so the host can persist them however it likes.
 */

/**
 * A configuration that has been visited or pinned. `name` distinguishes
 * named (permanent) presets from anonymous ones (subject to FIFO eviction).
 */
export type Preset = {
  uiHash: string;
  configHash: string;
  name?: string;
  lastSeenAt: number;
  configuration: Readonly<Record<string, number>>;
};

/**
 * One entry in the multi-selection over the library. Position is the
 * insertion order; the loop mode walks the selection in this order.
 */
export type SelectionEntry = {
  position: number;
  uiHash: string;
  configHash: string;
};

/**
 * Loop playback parameters (tempo, transition).
 */
export type LoopSettings = {
  bpm: number;
  transitionTimeMs: number;
  transitionLevel: 0 | 1;
};

/**
 * Append-only log of committed configurations on the current instance.
 * `uiHash` is checked against the component's signature on `setTrajectory`
 * — mismatched records are ignored.
 */
export type TrajectoryRecord = {
  uiHash: string;
  events: TrajectoryEvent[];
  headIndex: number;
  cursorIndex: number;
  updatedAt: number;
};

export type TrajectoryEvent = {
  timestampMs: number;
  configuration: Readonly<Record<string, number>>;
  transitionTimeMs?: number;
  transitionLevel?: 0 | 1;
  loopContext?: string;
};
