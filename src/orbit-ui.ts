/**
 * OrbitUI — public API of the Faust Orbit UI component.
 *
 * Thin wrapper around the legacy `FaustOrbitUI` renderer that adds:
 *   • a synchronous `uiHash` derived from the Faust UI signature,
 *   • an internal preset library cache + `setLibrary` / `onLibraryChange`,
 *   • undo / redo stubs (the actual stacks land in later increments).
 *
 * See ORBITUIAPISPEC.md and ORBITDATAMODELSPEC.md for the contract this
 * class implements. This file is intentionally minimal: trajectory,
 * selection, loop settings, calque, auto-promotion and the recall menu
 * are scheduled for subsequent steps and are NOT exposed yet.
 */
import { FaustOrbitUI } from './faust-orbit-ui.js';
import { computeUIHashSync } from './orbit-hash.js';
import type { Preset } from './orbit-types.js';

export type OrbitUIOptions = {
  /** Raw Faust UI descriptor (the `runtime.ui` array from faustwasm). */
  uiDescriptor: unknown;

  /** Notified for every parameter change initiated by the user. */
  onParamChange: (path: string, value: number) => void;

  /** Optional gesture bracketing for host-side autosave / undo. */
  onInteractionStart?: () => void;
  onInteractionEnd?: () => void;

  /** Emitted when the internal library mutates from inside the component
   *  (auto-promotion, rename, delete, undo / redo). NOT emitted in
   *  response to `setLibrary` — that is sync-in only. */
  onLibraryChange?: (records: Preset[]) => void;
};

export class OrbitUI {
  /** Identity of the Faust UI signature, computed at construction time. */
  readonly uiHash: string;

  private readonly inner: FaustOrbitUI;
  private readonly container: HTMLElement;
  private readonly onLibraryChange: ((records: Preset[]) => void) | null;

  /** Library cache, keyed by `configHash`. Authoritative within the
   *  component; the host pushes updates via `setLibrary`. */
  private library: Map<string, Preset>;

  constructor(container: HTMLElement, options: OrbitUIOptions) {
    if (!container || !(container instanceof HTMLElement)) {
      throw new Error('OrbitUI: missing container');
    }
    if (typeof options?.onParamChange !== 'function') {
      throw new Error('OrbitUI: options.onParamChange is required');
    }

    this.container = container;
    this.container.classList.add('orbit-ui-root');
    this.uiHash = computeUIHashSync(options.uiDescriptor);
    this.onLibraryChange = options.onLibraryChange ?? null;
    this.library = new Map();

    this.inner = new FaustOrbitUI(container, options.onParamChange, {
      onInteractionStart: options.onInteractionStart,
      onInteractionEnd: options.onInteractionEnd,
    });

    const initialState = this.inner.buildControlsFromUnknown(options.uiDescriptor);
    this.inner.setOrbitState(initialState);
  }

  /** Push parameter values from the host (e.g. after Faust restoration).
   *  Does NOT emit `onParamChange`. Invalidates the param undo stack
   *  (currently a no-op until the stack is implemented). */
  setParams(config: Readonly<Record<string, number>>): void {
    if (!config || typeof config !== 'object') return;
    this.inner.setParams(config);
  }

  /** Replace the library cache from the host (initial load or
   *  cross-instance sync). Records whose `uiHash` does not match this
   *  instance's signature are silently dropped. Does NOT emit
   *  `onLibraryChange`. Invalidates the library undo stack (no-op for
   *  now). */
  setLibrary(records: readonly Preset[]): void {
    if (!Array.isArray(records)) return;
    const next = new Map<string, Preset>();
    for (const record of records) {
      if (!isPreset(record)) continue;
      if (record.uiHash !== this.uiHash) continue;
      next.set(record.configHash, record);
    }
    this.library = next;
  }

  /** Snapshot of the current library cache (for tests / introspection;
   *  the host normally tracks library state via `onLibraryChange`). */
  getLibrary(): Preset[] {
    return Array.from(this.library.values());
  }

  /** Library undo / redo. Currently no-ops (the stack lands with the
   *  calque + auto-promotion implementation). Returns `false` so the
   *  host falls through to the parent scope. */
  undoLibrary(): boolean {
    void this.onLibraryChange;
    return false;
  }
  redoLibrary(): boolean {
    return false;
  }

  /** Param undo / redo. Currently no-ops; the stack lands together with
   *  the trajectory + commit machinery. */
  undoParams(): boolean {
    return false;
  }
  redoParams(): boolean {
    return false;
  }

  /** Detach from the DOM. After this call, no further events fire and
   *  internal caches are cleared. */
  destroy(): void {
    this.inner.destroy();
    this.container.classList.remove('orbit-ui-root');
    this.library.clear();
  }
}

function isPreset(value: unknown): value is Preset {
  if (!value || typeof value !== 'object') return false;
  const v = value as Record<string, unknown>;
  if (typeof v.uiHash !== 'string') return false;
  if (typeof v.configHash !== 'string') return false;
  if (typeof v.lastSeenAt !== 'number') return false;
  if (v.name !== undefined && typeof v.name !== 'string') return false;
  if (!v.configuration || typeof v.configuration !== 'object') return false;
  for (const cv of Object.values(v.configuration as Record<string, unknown>)) {
    if (typeof cv !== 'number') return false;
  }
  return true;
}
