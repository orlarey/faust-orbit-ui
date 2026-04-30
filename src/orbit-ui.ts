/**
 * OrbitUI — public API of the Faust Orbit UI component.
 *
 * Thin wrapper around the legacy `FaustOrbitUI` renderer that adds:
 *   • a synchronous `uiHash` derived from the Faust UI signature,
 *   • an internal preset library cache + `setLibrary`,
 *   • the niveau-1 calque (read-only over the library cache),
 *   • dwell-based auto-promotion (PRESETSPEC § « Mémorisation »),
 *   • multi-selection + trash (shift+click toggle, shift+drag marquee,
 *     trash button / Delete key),
 *   • undo / redo stubs (the actual stacks land in later increments).
 *
 * See ORBITUIAPISPEC.md and ORBITDATAMODELSPEC.md for the contract.
 */
import { FaustOrbitUI } from './faust-orbit-ui.js';
import { computeUIHashSync } from './orbit-hash.js';
import { OrbitCalque } from './orbit-calque.js';
import { extractParamSpecs, type ParamSpec } from './orbit-projection.js';
import { PresetPromotionTracker } from './orbit-promotion.js';
import type { Preset, SelectionEntry } from './orbit-types.js';

const PROMOTION_TICK_MS = 500;

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

  /** Emitted when the multi-selection mutates from inside the component
   *  (shift+click, shift+drag marquee, trash). NOT emitted in response
   *  to `setSelection` — sync-in only. */
  onSelectionChange?: (entries: SelectionEntry[]) => void;
};

export class OrbitUI {
  /** Identity of the Faust UI signature, computed at construction time. */
  readonly uiHash: string;

  private readonly inner: FaustOrbitUI;
  private readonly container: HTMLElement;
  private readonly onLibraryChange: ((records: Preset[]) => void) | null;
  private readonly onSelectionChangeUser: ((entries: SelectionEntry[]) => void) | null;
  private readonly paramSpecs: ReadonlyArray<ParamSpec>;
  private readonly userOnParamChange: (path: string, value: number) => void;
  private readonly calque: OrbitCalque;
  private readonly toggleButton: HTMLButtonElement;
  private readonly onKeyDown: (e: KeyboardEvent) => void;
  private readonly tracker: PresetPromotionTracker;
  private tickerId: number | null = null;

  /** Library cache, keyed by `configHash`. */
  private library: Map<string, Preset>;
  /** Selection of configHashes in insertion order. */
  private selection: string[];

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
    this.onSelectionChangeUser = options.onSelectionChange ?? null;
    this.userOnParamChange = options.onParamChange;
    this.library = new Map();
    this.selection = [];
    this.tracker = new PresetPromotionTracker();

    const userStart = options.onInteractionStart;
    const userEnd = options.onInteractionEnd;
    const wrappedStart = (): void => {
      this.tracker.setInGesture(true);
      userStart?.();
    };
    const wrappedEnd = (): void => {
      this.tracker.setInGesture(false);
      this.tracker.recordCommit();
      userEnd?.();
    };

    this.inner = new FaustOrbitUI(container, options.onParamChange, {
      onInteractionStart: wrappedStart,
      onInteractionEnd: wrappedEnd,
    });

    const initialState = this.inner.buildControlsFromUnknown(options.uiDescriptor);
    this.inner.setOrbitState(initialState);

    this.calque = new OrbitCalque({
      container,
      paramSpecs: this.paramSpecs,
      getCurrentParams: () => this.inner.getParamValues(),
      onApply: (cfg) => this.applyConfigFromCalque(cfg),
      onSelectionChange: (hashes) => this.handleCalqueSelectionChange(hashes),
      onTrashSelected: () => this.handleTrashSelected(),
      onPresetRename: (hash, name) => this.handlePresetRename(hash, name),
      onInteractionStart: wrappedStart,
      onInteractionEnd: wrappedEnd,
    });

    this.toggleButton = this.injectLibraryButton();
    this.onKeyDown = (e) => this.handleKeyDown(e);
    this.container.addEventListener('keydown', this.onKeyDown);

    this.tickerId = window.setInterval(() => this.tickPromotion(), PROMOTION_TICK_MS);
  }

  setParams(config: Readonly<Record<string, number>>): void {
    if (!config || typeof config !== 'object') return;
    this.inner.setParams(config);
  }

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
    // Drop selection entries that no longer reference an existing preset.
    this.selection = this.selection.filter((h) => this.library.has(h));
    this.calque.setSelection(this.selection);
  }

  setSelection(entries: readonly SelectionEntry[]): void {
    if (!Array.isArray(entries)) return;
    const valid = entries
      .filter((e) => isSelectionEntry(e) && e.uiHash === this.uiHash && this.library.has(e.configHash))
      .slice()
      .sort((a, b) => a.position - b.position)
      .map((e) => e.configHash);
    // Deduplicate while preserving order.
    const seen = new Set<string>();
    this.selection = [];
    for (const h of valid) {
      if (seen.has(h)) continue;
      seen.add(h);
      this.selection.push(h);
    }
    this.calque.setSelection(this.selection);
  }

  getLibrary(): Preset[] {
    return this.libraryArray();
  }

  getSelection(): SelectionEntry[] {
    return this.selectionEntries();
  }

  setPromotionSuspended(suspended: boolean): void {
    this.tracker.setSuspended(suspended);
  }

  undoLibrary(): boolean { return false; }
  redoLibrary(): boolean { return false; }
  undoParams(): boolean { return false; }
  redoParams(): boolean { return false; }

  destroy(): void {
    if (this.tickerId !== null) {
      window.clearInterval(this.tickerId);
      this.tickerId = null;
    }
    this.container.removeEventListener('keydown', this.onKeyDown);
    this.toggleButton.remove();
    this.calque.destroy();
    this.inner.destroy();
    this.container.classList.remove('orbit-ui-root');
    this.library.clear();
    this.selection = [];
  }

  // ------------------------------------------------------------------------

  private libraryArray(): Preset[] {
    return Array.from(this.library.values());
  }

  private selectionEntries(): SelectionEntry[] {
    return this.selection.map((configHash, position) => ({
      position,
      uiHash: this.uiHash,
      configHash,
    }));
  }

  private applyConfigFromCalque(cfg: Record<string, number>): void {
    this.inner.setParams(cfg);
    for (const [path, value] of Object.entries(cfg)) {
      this.userOnParamChange(path, value);
    }
  }

  private handleCalqueSelectionChange(configHashes: ReadonlyArray<string>): void {
    // Deduplicate while preserving order; clip to the current library.
    const seen = new Set<string>();
    this.selection = [];
    for (const h of configHashes) {
      if (seen.has(h)) continue;
      if (!this.library.has(h)) continue;
      seen.add(h);
      this.selection.push(h);
    }
    this.onSelectionChangeUser?.(this.selectionEntries());
  }

  private handlePresetRename(configHash: string, name: string): void {
    const existing = this.library.get(configHash);
    if (!existing) return;
    const trimmed = name.trim();
    const next: Preset = trimmed.length > 0
      ? { ...existing, name: trimmed }
      : (() => { const { name: _omit, ...rest } = existing; void _omit; return rest; })();
    if (
      next.name === existing.name
      || (next.name === undefined && existing.name === undefined)
    ) {
      // No change.
      return;
    }
    this.library.set(configHash, next);
    this.calque.setLibrary(this.libraryArray());
    this.onLibraryChange?.(this.libraryArray());
  }

  private handleTrashSelected(): void {
    if (this.selection.length === 0) return;
    let mutated = false;
    for (const h of this.selection) {
      if (this.library.delete(h)) mutated = true;
    }
    if (!mutated) return;
    this.selection = [];
    this.calque.setSelection(this.selection);
    this.calque.setLibrary(this.libraryArray());
    this.onSelectionChangeUser?.(this.selectionEntries());
    this.onLibraryChange?.(this.libraryArray());
  }

  private tickPromotion(): void {
    if (!this.tracker.isArmed()) return;
    const result = this.tracker.evaluate(this.uiHash, this.inner.getParamValues());
    if (!result.promoted) return;
    const candidate = result.preset;
    const existing = this.library.get(candidate.configHash);
    const merged: Preset = existing
      ? { ...existing, lastSeenAt: candidate.lastSeenAt }
      : candidate;
    this.library.set(merged.configHash, merged);
    this.calque.setLibrary(this.libraryArray());
    this.onLibraryChange?.(this.libraryArray());
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
      this.syncCalqueState();
    });
    if (middle) {
      middle.appendChild(button);
    } else {
      this.container.appendChild(button);
    }
    return button;
  }

  private syncCalqueState(): void {
    const visible = this.calque.isVisible();
    this.toggleButton.setAttribute('aria-pressed', String(visible));
    this.tracker.setOverlayActive(visible);
  }

  private handleKeyDown(e: KeyboardEvent): void {
    const target = e.target as HTMLElement | null;
    if (target && /^(INPUT|SELECT|TEXTAREA)$/.test(target.tagName)) return;
    if (e.key === 'l' || e.key === 'L') {
      if (e.metaKey || e.ctrlKey || e.altKey) return;
      e.preventDefault();
      this.calque.toggle();
      this.syncCalqueState();
      return;
    }
    if (e.key === 'Escape' && this.calque.isVisible()) {
      e.preventDefault();
      this.calque.hide();
      this.syncCalqueState();
      return;
    }
    if ((e.key === 'Delete' || e.key === 'Backspace') && this.calque.isVisible()) {
      if (e.metaKey || e.ctrlKey || e.altKey) return;
      if (this.selection.length === 0) return;
      e.preventDefault();
      this.calque.trashSelected();
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

function isSelectionEntry(value: unknown): value is SelectionEntry {
  if (!value || typeof value !== 'object') return false;
  const v = value as Record<string, unknown>;
  return typeof v.position === 'number'
    && typeof v.uiHash === 'string'
    && typeof v.configHash === 'string';
}
