/**
 * OrbitUI — public API of the Faust Orbit UI component.
 *
 * Thin wrapper around the legacy `FaustOrbitUI` renderer that adds:
 *   • a synchronous `uiHash` derived from the Faust UI signature,
 *   • an internal preset library cache + `setLibrary`,
 *   • the niveau-1 calque (read-only over the library cache),
 *   • undo / redo stubs (the actual stacks land in later increments).
 *
 * See ORBITUIAPISPEC.md and ORBITDATAMODELSPEC.md for the contract.
 */
import { FaustOrbitUI } from './faust-orbit-ui.js';
import { computeUIHashSync } from './orbit-hash.js';
import { OrbitCalque } from './orbit-calque.js';
import { extractParamSpecs, type ParamSpec } from './orbit-projection.js';
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
  private readonly paramSpecs: ReadonlyArray<ParamSpec>;
  private readonly userOnParamChange: (path: string, value: number) => void;
  private readonly calque: OrbitCalque;
  private readonly toggleButton: HTMLButtonElement;
  private readonly onKeyDown: (e: KeyboardEvent) => void;

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
    this.paramSpecs = extractParamSpecs(options.uiDescriptor);
    this.onLibraryChange = options.onLibraryChange ?? null;
    this.userOnParamChange = options.onParamChange;
    this.library = new Map();

    this.inner = new FaustOrbitUI(container, options.onParamChange, {
      onInteractionStart: options.onInteractionStart,
      onInteractionEnd: options.onInteractionEnd,
    });

    const initialState = this.inner.buildControlsFromUnknown(options.uiDescriptor);
    this.inner.setOrbitState(initialState);

    this.calque = new OrbitCalque({
      container,
      paramSpecs: this.paramSpecs,
      getCurrentParams: () => this.inner.getParamValues(),
      onApply: (cfg) => this.applyConfigFromCalque(cfg),
      onInteractionStart: options.onInteractionStart,
      onInteractionEnd: options.onInteractionEnd,
    });

    this.toggleButton = this.injectLibraryButton();
    this.onKeyDown = (e) => this.handleKeyDown(e);
    this.container.addEventListener('keydown', this.onKeyDown);
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
    this.calque.setLibrary(this.libraryArray());
  }

  /** Snapshot of the current library cache. */
  getLibrary(): Preset[] {
    return this.libraryArray();
  }

  /** Library undo / redo. Currently no-ops (stack lands with auto-promotion
   *  + library mutations in step 2.B / 2.C). */
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

  /** Detach from the DOM. */
  destroy(): void {
    this.container.removeEventListener('keydown', this.onKeyDown);
    this.toggleButton.remove();
    this.calque.destroy();
    this.inner.destroy();
    this.container.classList.remove('orbit-ui-root');
    this.library.clear();
  }

  // ------------------------------------------------------------------------

  private libraryArray(): Preset[] {
    return Array.from(this.library.values());
  }

  private applyConfigFromCalque(cfg: Record<string, number>): void {
    // Update the inner orbit-ui's visual + cached values, AND emit
    // onParamChange to the host for each address so the audio runtime
    // mirrors the change.
    this.inner.setParams(cfg);
    for (const [path, value] of Object.entries(cfg)) {
      this.userOnParamChange(path, value);
    }
  }

  private injectLibraryButton(): HTMLButtonElement {
    const middle = this.container.querySelector<HTMLElement>('.orbit-middle-actions');
    const button = document.createElement('button');
    button.type = 'button';
    button.className = 'orbit-library-btn';
    button.textContent = 'Library';
    button.title = 'Toggle preset library overlay (L)';
    button.setAttribute('aria-pressed', 'false');
    button.addEventListener('click', () => {
      this.calque.toggle();
      this.syncToggleState();
    });
    if (middle) {
      middle.appendChild(button);
    } else {
      this.container.appendChild(button);
    }
    return button;
  }

  private syncToggleState(): void {
    this.toggleButton.setAttribute('aria-pressed', String(this.calque.isVisible()));
  }

  private handleKeyDown(e: KeyboardEvent): void {
    const target = e.target as HTMLElement | null;
    if (target && /^(INPUT|SELECT|TEXTAREA)$/.test(target.tagName)) return;
    if (e.metaKey || e.ctrlKey || e.altKey) return;
    if (e.key === 'l' || e.key === 'L') {
      e.preventDefault();
      this.calque.toggle();
      this.syncToggleState();
      return;
    }
    if (e.key === 'Escape' && this.calque.isVisible()) {
      e.preventDefault();
      this.calque.hide();
      this.syncToggleState();
    }
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
