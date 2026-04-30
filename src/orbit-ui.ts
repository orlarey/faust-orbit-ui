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
 *   • inline preset renaming (double-click),
 *   • library undo / redo (per uiHash, scoped to this instance).
 *
 * Param undo / redo land together with the trajectory + commit machinery
 * in step 3.
 *
 * See ORBITUIAPISPEC.md and ORBITDATAMODELSPEC.md for the contract.
 */
import { FaustOrbitUI } from './faust-orbit-ui.js';
import { computeUIHashSync } from './orbit-hash.js';
import { OrbitCalque } from './orbit-calque.js';
import { extractParamSpecs, type ParamSpec } from './orbit-projection.js';
import { PresetPromotionTracker } from './orbit-promotion.js';
import { LibraryUndoScope, type LibraryOp } from './orbit-library-undo.js';
import { computeConfigHashSync } from './orbit-hash.js';
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
  private readonly trashButton: HTMLButtonElement;
  private readonly presetsBadge: HTMLSpanElement;
  private readonly onKeyDown: (e: KeyboardEvent) => void;
  private readonly tracker: PresetPromotionTracker;
  private readonly libraryUndo: LibraryUndoScope;
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
    this.libraryUndo = new LibraryUndoScope();

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
      onCreatePresetAt: (projPos) => this.handleCreatePresetAt(projPos),
      onInteractionStart: wrappedStart,
      onInteractionEnd: wrappedEnd,
    });

    this.toggleButton = this.injectLibraryButton();
    this.trashButton = this.injectTrashButton();
    this.presetsBadge = this.injectPresetsBadge();
    this.updatePresetsBadge();
    this.updateTrashButtonVisibility();
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
    // External library push invalidates the undo history.
    this.libraryUndo.clear();
    this.calque.setLibrary(this.libraryArray());
    this.selection = this.selection.filter((h) => this.library.has(h));
    this.calque.setSelection(this.selection);
    this.updatePresetsBadge();
  }

  setSelection(entries: readonly SelectionEntry[]): void {
    if (!Array.isArray(entries)) return;
    const valid = entries
      .filter((e) => isSelectionEntry(e) && e.uiHash === this.uiHash && this.library.has(e.configHash))
      .slice()
      .sort((a, b) => a.position - b.position)
      .map((e) => e.configHash);
    const seen = new Set<string>();
    this.selection = [];
    for (const h of valid) {
      if (seen.has(h)) continue;
      seen.add(h);
      this.selection.push(h);
    }
    this.calque.setSelection(this.selection);
    this.updatePresetsBadge();
  }

  getLibrary(): Preset[] { return this.libraryArray(); }
  getSelection(): SelectionEntry[] { return this.selectionEntries(); }

  setPromotionSuspended(suspended: boolean): void {
    this.tracker.setSuspended(suspended);
  }

  undoLibrary(): boolean {
    const op = this.libraryUndo.popUndo();
    if (!op) return false;
    this.revertLibraryOp(op);
    this.emitLibraryChange();
    return true;
  }

  redoLibrary(): boolean {
    const op = this.libraryUndo.popRedo();
    if (!op) return false;
    this.applyLibraryOp(op);
    this.emitLibraryChange();
    return true;
  }

  undoParams(): boolean { return false; }
  redoParams(): boolean { return false; }

  destroy(): void {
    if (this.tickerId !== null) {
      window.clearInterval(this.tickerId);
      this.tickerId = null;
    }
    this.container.removeEventListener('keydown', this.onKeyDown);
    this.toggleButton.remove();
    this.trashButton.remove();
    this.presetsBadge.remove();
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

  private emitLibraryChange(): void {
    this.calque.setLibrary(this.libraryArray());
    this.updatePresetsBadge();
    this.onLibraryChange?.(this.libraryArray());
  }

  private applyConfigFromCalque(cfg: Record<string, number>): void {
    this.inner.setParams(cfg);
    for (const [path, value] of Object.entries(cfg)) {
      this.userOnParamChange(path, value);
    }
  }

  private handleCalqueSelectionChange(configHashes: ReadonlyArray<string>): void {
    const seen = new Set<string>();
    this.selection = [];
    for (const h of configHashes) {
      if (seen.has(h)) continue;
      if (!this.library.has(h)) continue;
      seen.add(h);
      this.selection.push(h);
    }
    this.updatePresetsBadge();
    this.onSelectionChangeUser?.(this.selectionEntries());
  }

  private handlePresetRename(configHash: string, name: string): void {
    const existing = this.library.get(configHash);
    if (!existing) return;
    const trimmed = name.trim();
    const nextName: string | undefined = trimmed.length > 0 ? trimmed : undefined;
    if (nextName === existing.name) return;
    this.library.set(configHash, applyName(existing, nextName));
    this.libraryUndo.record({
      kind: 'rename',
      configHash,
      prevName: existing.name,
      nextName,
    });
    this.emitLibraryChange();
  }

  private handleCreatePresetAt(projPos: readonly [number, number]): void {
    const configuration = { ...this.inner.getParamValues() };
    const configHash = computeConfigHashSync(configuration);
    if (this.library.has(configHash)) {
      // Already known — just refresh lastSeenAt, anchor the existing
      // disc at the new position so the user sees feedback at click.
      const existing = this.library.get(configHash)!;
      this.library.set(configHash, { ...existing, lastSeenAt: Date.now() });
      this.calque.registerAnchorOverride(configHash, projPos);
      this.emitLibraryChange();
      return;
    }
    const preset: Preset = {
      uiHash: this.uiHash,
      configHash,
      lastSeenAt: Date.now(),
      configuration,
    };
    this.library.set(configHash, preset);
    this.libraryUndo.record({ kind: 'add', record: preset });
    this.calque.registerAnchorOverride(configHash, projPos);
    this.emitLibraryChange();
  }

  private handleTrashSelected(): void {
    if (this.selection.length === 0) return;
    const records: Preset[] = [];
    for (const h of this.selection) {
      const r = this.library.get(h);
      if (r) records.push(r);
    }
    if (records.length === 0) return;
    for (const r of records) this.library.delete(r.configHash);
    this.selection = [];
    this.calque.setSelection(this.selection);
    this.onSelectionChangeUser?.(this.selectionEntries());
    this.libraryUndo.record(
      records.length === 1
        ? { kind: 'delete', record: records[0]! }
        : { kind: 'deleteBatch', records },
    );
    this.emitLibraryChange();
  }

  private tickPromotion(): void {
    if (!this.tracker.isArmed()) return;
    const result = this.tracker.evaluate(this.uiHash, this.inner.getParamValues());
    if (!result.promoted) return;
    const candidate = result.preset;
    const existing = this.library.get(candidate.configHash);
    if (existing) {
      // Re-promotion of a known config: bump lastSeenAt, preserve name.
      // Not undoable — informational state only.
      this.library.set(candidate.configHash, { ...existing, lastSeenAt: candidate.lastSeenAt });
    } else {
      this.library.set(candidate.configHash, candidate);
      this.libraryUndo.record({ kind: 'add', record: candidate });
    }
    this.emitLibraryChange();
  }

  private revertLibraryOp(op: LibraryOp): void {
    switch (op.kind) {
      case 'add':
        this.library.delete(op.record.configHash);
        // Drop selection entries pointing at the removed preset.
        if (this.selection.includes(op.record.configHash)) {
          this.selection = this.selection.filter((h) => h !== op.record.configHash);
          this.calque.setSelection(this.selection);
          this.onSelectionChangeUser?.(this.selectionEntries());
        }
        return;
      case 'delete':
        this.library.set(op.record.configHash, op.record);
        return;
      case 'deleteBatch':
        for (const r of op.records) this.library.set(r.configHash, r);
        return;
      case 'rename': {
        const cur = this.library.get(op.configHash);
        if (!cur) return;
        this.library.set(op.configHash, applyName(cur, op.prevName));
        return;
      }
    }
  }

  private applyLibraryOp(op: LibraryOp): void {
    switch (op.kind) {
      case 'add':
        this.library.set(op.record.configHash, op.record);
        return;
      case 'delete':
        this.library.delete(op.record.configHash);
        if (this.selection.includes(op.record.configHash)) {
          this.selection = this.selection.filter((h) => h !== op.record.configHash);
          this.calque.setSelection(this.selection);
          this.onSelectionChangeUser?.(this.selectionEntries());
        }
        return;
      case 'deleteBatch':
        {
          const removed = new Set(op.records.map((r) => r.configHash));
          for (const r of op.records) this.library.delete(r.configHash);
          if (this.selection.some((h) => removed.has(h))) {
            this.selection = this.selection.filter((h) => !removed.has(h));
            this.calque.setSelection(this.selection);
            this.onSelectionChangeUser?.(this.selectionEntries());
          }
        }
        return;
      case 'rename': {
        const cur = this.library.get(op.configHash);
        if (!cur) return;
        this.library.set(op.configHash, applyName(cur, op.nextName));
        return;
      }
    }
  }

  private injectTrashButton(): HTMLButtonElement {
    const middle = this.container.querySelector<HTMLElement>('.orbit-middle-actions');
    const button = document.createElement('button');
    button.type = 'button';
    button.className = 'orbit-trash-btn';
    button.title = 'Delete selected presets (Delete)';
    button.setAttribute('aria-label', 'Delete selected presets');
    const icon = document.createElement('span');
    icon.className = 'material-symbols-outlined';
    icon.textContent = 'delete';
    button.appendChild(icon);
    button.addEventListener('click', () => this.handleTrashSelected());
    if (middle) middle.appendChild(button);
    else this.container.appendChild(button);
    return button;
  }

  private updateTrashButtonVisibility(): void {
    this.trashButton.hidden = this.selection.length === 0;
  }

  private injectPresetsBadge(): HTMLSpanElement {
    const middle = this.container.querySelector<HTMLElement>('.orbit-middle-actions');
    const span = document.createElement('span');
    span.className = 'orbit-presets-count';
    span.title = 'Memorised presets for this signature';
    if (middle) middle.appendChild(span);
    else this.container.appendChild(span);
    return span;
  }

  private updatePresetsBadge(): void {
    const total = this.library.size;
    const sel = this.selection.length;
    this.presetsBadge.textContent = sel > 0 ? `${sel}/${total}` : String(total);
    this.updateTrashButtonVisibility();
  }

  private injectLibraryButton(): HTMLButtonElement {
    const middle = this.container.querySelector<HTMLElement>('.orbit-middle-actions');
    const button = document.createElement('button');
    button.type = 'button';
    button.className = 'orbit-library-btn';
    button.setAttribute('aria-label', 'Library');
    button.title = 'Toggle preset library overlay (L)';
    button.setAttribute('aria-pressed', 'false');
    const icon = document.createElement('span');
    icon.className = 'material-symbols-outlined';
    icon.textContent = 'bubble_chart';
    button.appendChild(icon);
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

function applyName(p: Preset, name: string | undefined): Preset {
  if (!name) {
    const { name: _omit, ...rest } = p;
    void _omit;
    return rest as Preset;
  }
  return { ...p, name };
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
