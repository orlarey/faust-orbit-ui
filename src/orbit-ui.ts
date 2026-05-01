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
import { enableCustomDropdown, openDropdownMenu, type DropdownItem } from './orbit-dropdown.js';
import type {
  Preset,
  SelectionEntry,
  TrajectoryEvent,
  TrajectoryRecord,
} from './orbit-types.js';

const PROMOTION_TICK_MS = 500;
/** FIFO eviction threshold for the trajectory event log (per
 *  ORBITDATAMODELSPEC §C). The oldest events are dropped beyond this. */
const TRAJECTORY_MAX_EVENTS = 500;

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

  /** Emitted at the end of every gesture that settles a configuration
   *  (knob drag release, calque centre drag release, click-to-recall,
   *  arrow-nav step end, recall-menu pick, …). Carries the configuration
   *  the gesture committed to. Useful for analytics and badges; for the
   *  authoritative trajectory state see `onTrajectoryChange`. */
  onCommit?: (configuration: Readonly<Record<string, number>>) => void;

  /** Emitted whenever the trajectory log mutates (a new commit appended,
   *  or a navigation cursor move). The host receives the full record
   *  and is responsible for persisting it (per `(sessionId, instanceId)`
   *  or whatever key it uses). NOT emitted in response to
   *  `setTrajectory` — sync-in only. */
  onTrajectoryChange?: (record: TrajectoryRecord) => void;
};

export class OrbitUI {
  /** Identity of the Faust UI signature, computed at construction time. */
  readonly uiHash: string;

  private readonly inner: FaustOrbitUI;
  private readonly container: HTMLElement;
  private readonly onLibraryChange: ((records: Preset[]) => void) | null;
  private readonly onSelectionChangeUser: ((entries: SelectionEntry[]) => void) | null;
  private readonly onCommitUser: ((cfg: Readonly<Record<string, number>>) => void) | null;
  private readonly onTrajectoryChangeUser: ((record: TrajectoryRecord) => void) | null;
  private readonly paramSpecs: ReadonlyArray<ParamSpec>;
  private readonly userOnParamChange: (path: string, value: number) => void;
  private readonly calque: OrbitCalque;
  private readonly toggleButton: HTMLButtonElement;
  private readonly trashButton: HTMLButtonElement;
  private readonly presetsBadge: HTMLSpanElement;
  private readonly presetsSelect: HTMLSelectElement;
  private readonly presetsCountLabel: HTMLSpanElement;
  private readonly onKeyDown: (e: KeyboardEvent) => void;
  private readonly tracker: PresetPromotionTracker;
  private readonly libraryUndo: LibraryUndoScope;
  private wrappedInteractionStart!: () => void;
  private wrappedInteractionEnd!: () => void;
  private tickerId: number | null = null;

  /** Library cache, keyed by `configHash`. */
  private library: Map<string, Preset>;
  /** Selection of configHashes in insertion order. */
  private selection: string[];
  /** Append-only trajectory log per ORBITDATAMODELSPEC §C. */
  private trajectory: TrajectoryRecord;

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
    this.onCommitUser = options.onCommit ?? null;
    this.onTrajectoryChangeUser = options.onTrajectoryChange ?? null;
    this.userOnParamChange = options.onParamChange;
    this.library = new Map();
    this.selection = [];
    this.trajectory = {
      uiHash: this.uiHash,
      events: [],
      headIndex: -1,
      cursorIndex: -1,
      updatedAt: 0,
    };
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
      this.recordTrajectoryCommit();
      userEnd?.();
    };
    // Save references so non-pointer code paths (recall menu, etc.)
    // can bracket their own commits through the same pipeline.
    this.wrappedInteractionStart = wrappedStart;
    this.wrappedInteractionEnd = wrappedEnd;

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
    const badge = this.injectPresetsBadge();
    this.presetsBadge = badge.wrap;
    this.presetsCountLabel = badge.label;
    this.presetsSelect = badge.select;
    this.updatePresetsBadge();
    this.updateTrashButtonVisibility();
    this.onKeyDown = (e) => this.handleKeyDown(e);
    this.container.addEventListener('keydown', this.onKeyDown);
    this.installNarrowToolbarHandlers();
    this.installCustomToolbarDropdowns();

    this.tickerId = window.setInterval(() => this.tickPromotion(), PROMOTION_TICK_MS);
  }

  /**
   * Replace the native popups of every toolbar `<select>` with our
   * theme-styled dropdown. The selects stay in DOM as state holders
   * (their `change` events still drive FaustOrbitUI's zoom / random
   * handlers); we just re-route how the popup is opened.
   */
  private installCustomToolbarDropdowns(): void {
    const mix = this.container.querySelector<HTMLSelectElement>('.orbit-random-mix');
    const zoom = this.container.querySelector<HTMLSelectElement>('.orbit-zoom');
    if (mix) enableCustomDropdown(mix);
    if (zoom) enableCustomDropdown(zoom);
    enableCustomDropdown(this.presetsSelect, () => this.buildPresetsDropdownItems());
  }

  /** Build the preset dropdown items (mirrors rebuildPresetSelectOptions
   *  but as DropdownItem records instead of <option> elements). */
  private buildPresetsDropdownItems(): ReadonlyArray<DropdownItem> {
    const items: DropdownItem[] = [];
    const params = this.inner.getParamValues();
    const matchesNamed = this.libraryArray().some(
      (p) => typeof p.name === 'string' && p.name.length > 0
        && this.matchesCurrentParams(p, params),
    );
    items.push({
      kind: 'option',
      value: '__save__',
      label: '+ Save current state as preset',
      disabled: matchesNamed,
    });
    const named = this.libraryArray()
      .filter((p) => typeof p.name === 'string' && p.name.length > 0)
      .sort((a, b) => (a.name ?? '').localeCompare(b.name ?? '', undefined, { sensitivity: 'base' }));
    if (named.length > 0) {
      items.push({ kind: 'separator' });
      for (const preset of named) {
        items.push({
          kind: 'option',
          value: preset.configHash,
          label: preset.name!,
          active: this.matchesCurrentParams(preset, params),
        });
      }
    }
    return items;
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

  /** Replace the trajectory record from outside (initial load or
   *  cross-instance sync). Records whose `uiHash` does not match the
   *  current signature are ignored. Does NOT emit `onTrajectoryChange`. */
  setTrajectory(record: TrajectoryRecord): void {
    if (!record || typeof record !== 'object') return;
    if (record.uiHash !== this.uiHash) return;
    if (!Array.isArray(record.events)) return;
    const events: TrajectoryEvent[] = [];
    for (const e of record.events) {
      if (!isTrajectoryEvent(e)) continue;
      events.push(normaliseTrajectoryEvent(e));
    }
    const trimmed = events.slice(-TRAJECTORY_MAX_EVENTS);
    const len = trimmed.length;
    const head = clampIndex(record.headIndex, len);
    const cursor = clampIndex(record.cursorIndex, len);
    this.trajectory = {
      uiHash: this.uiHash,
      events: trimmed,
      headIndex: head,
      cursorIndex: cursor,
      updatedAt: typeof record.updatedAt === 'number' ? record.updatedAt : Date.now(),
    };
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
  getTrajectory(): TrajectoryRecord { return this.snapshotTrajectory(); }

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

  /**
   * Build the count badge as a pill-shaped wrapper that contains a
   * visible count label AND a transparent native `<select>` overlaying
   * it. Click anywhere on the badge → showPicker() opens the native
   * dropdown — same trick used for the narrow-mode random/zoom
   * dropdowns. Options are rebuilt fresh each time the picker opens
   * (so the active ✓ and the named-preset list reflect live state).
   */
  private injectPresetsBadge(): {
    wrap: HTMLSpanElement;
    label: HTMLSpanElement;
    select: HTMLSelectElement;
  } {
    const middle = this.container.querySelector<HTMLElement>('.orbit-middle-actions');
    const wrap = document.createElement('span');
    wrap.className = 'orbit-presets-count';
    wrap.title = 'Recall a named preset';

    const label = document.createElement('span');
    label.className = 'orbit-presets-count-label';
    wrap.appendChild(label);

    const select = document.createElement('select');
    select.className = 'orbit-presets-select';
    select.setAttribute('aria-label', 'Recall a named preset');
    wrap.appendChild(select);

    // Rebuild options just-in-time so they reflect the live library.
    const refreshOptions = (): void => {
      this.rebuildPresetSelectOptions(select);
    };
    select.addEventListener('mousedown', refreshOptions);
    select.addEventListener('focus', refreshOptions);
    select.addEventListener('change', () => this.handlePresetSelectChange(select));

    // The transparent <select> overlays the badge with `pointer-events:
    // auto`, so clicks anywhere on the wrap reach it; its mousedown
    // listener (added later by enableCustomDropdown) opens the themed
    // popup. No separate wrap click handler needed.

    if (middle) middle.appendChild(wrap);
    else this.container.appendChild(wrap);
    return { wrap, label, select };
  }

  private rebuildPresetSelectOptions(select: HTMLSelectElement): void {
    while (select.firstChild) select.removeChild(select.firstChild);

    // Sentinel option — picked as the fallback "selected" so the
    // native picker doesn't auto-highlight "+" or the first preset
    // when no named preset matches the current state.
    const sentinel = document.createElement('option');
    sentinel.value = '';
    sentinel.hidden = true;
    sentinel.disabled = true;
    select.appendChild(sentinel);

    const params = this.inner.getParamValues();
    const matchesNamed = this.libraryArray().some(
      (p) => typeof p.name === 'string' && p.name.length > 0
        && this.matchesCurrentParams(p, params),
    );
    const saveOption = document.createElement('option');
    saveOption.value = '__save__';
    saveOption.textContent = '+ Save current state as preset';
    saveOption.disabled = matchesNamed;
    select.appendChild(saveOption);

    const named = this.libraryArray()
      .filter((p) => typeof p.name === 'string' && p.name.length > 0)
      .sort((a, b) => (a.name ?? '').localeCompare(b.name ?? '', undefined, { sensitivity: 'base' }));
    let activeFound = false;
    if (named.length > 0) {
      const sep = document.createElement('option');
      sep.disabled = true;
      sep.textContent = '──────────';
      select.appendChild(sep);
      for (const preset of named) {
        const opt = document.createElement('option');
        opt.value = preset.configHash;
        opt.textContent = preset.name!;
        // The browser draws a native ✓ in the gutter for the selected
        // option — no manual prefix needed. Marking the active preset
        // as `selected` triggers that gutter check.
        if (this.matchesCurrentParams(preset, params)) {
          opt.selected = true;
          activeFound = true;
        }
        select.appendChild(opt);
      }
    }
    if (!activeFound) sentinel.selected = true;
  }

  private handlePresetSelectChange(select: HTMLSelectElement): void {
    const value = select.value;
    // Reset to the sentinel so the next pick of the same option still
    // fires `change` (a native select doesn't fire change when the
    // selected value doesn't actually change).
    select.selectedIndex = 0;
    if (!value) return;
    if (value === '__save__') {
      const name = window.prompt('Preset name (leave empty for anonymous):', '');
      if (name === null) return;
      this.handleSaveCurrentAsPreset(name);
      return;
    }
    const preset = this.library.get(value);
    if (preset) this.recallPreset(preset);
  }

  /**
   * True iff every paramSpec address has the same value in `preset` and
   * in `params` (within a small tolerance). Robust to presets whose
   * stored configuration covers a subset of the spec — missing keys
   * fall back to the spec's default on both sides.
   */
  private matchesCurrentParams(
    preset: Preset,
    params: Readonly<Record<string, number>>,
  ): boolean {
    for (const spec of this.paramSpecs) {
      const a = preset.configuration[spec.address] ?? spec.default;
      const b = params[spec.address] ?? spec.default;
      if (Math.abs(a - b) > 1e-9) return false;
    }
    return true;
  }

  /**
   * Apply a preset's stored configuration to the audio + the inner
   * orbit-ui. Same gesture machinery as a click on the calque disc
   * (auto-promotion will bump lastSeenAt naturally if the user lingers
   * past the dwell threshold).
   */
  private recallPreset(preset: Preset): void {
    // Bracket the recall as a gesture so it flows through the commit
    // pipeline (auto-promotion tracker, trajectory log, host's
    // onInteractionStart/End / onCommit).
    this.wrappedInteractionStart();
    if (this.calque.isVisible()) {
      // Calque open: same effect as a click on the disc — snap the
      // centre, make this preset the selection.
      this.calque.recallByHash(preset.configHash);
    } else {
      // Calque closed: just push the configuration into the audio.
      const cfg: Record<string, number> = {};
      for (const spec of this.paramSpecs) {
        cfg[spec.address] = preset.configuration[spec.address] ?? spec.default;
      }
      this.inner.setParams(cfg);
      for (const [path, value] of Object.entries(cfg)) {
        this.userOnParamChange(path, value);
      }
    }
    this.wrappedInteractionEnd();
  }

  /**
   * "+" entry of the recall menu: capture the current audible params as
   * a new preset. `name` is optional — empty / undefined creates an
   * anonymous preset (subject to FIFO eviction); a non-empty trimmed
   * value creates a named (permanent) preset. If any existing preset
   * already represents the same configuration (canonical value-by-value
   * match), we don't duplicate — instead we either rename it (if a new
   * name was supplied) or just bump its lastSeenAt.
   */
  private handleSaveCurrentAsPreset(name?: string): void {
    const trimmed = (name ?? '').trim();
    const params = this.inner.getParamValues();

    for (const existing of this.library.values()) {
      if (!this.matchesCurrentParams(existing, params)) continue;
      if (trimmed.length > 0 && existing.name !== trimmed) {
        // Apply the new name through the rename pipeline (records a
        // rename op on the library undo stack).
        this.handlePresetRename(existing.configHash, trimmed);
      } else {
        // No-op rename: just refresh recency.
        this.library.set(existing.configHash, { ...existing, lastSeenAt: Date.now() });
        this.emitLibraryChange();
      }
      return;
    }

    // Build a canonicalized configuration covering every paramSpec so
    // future configHash lookups are stable.
    const cfg: Record<string, number> = {};
    for (const spec of this.paramSpecs) {
      cfg[spec.address] = params[spec.address] ?? spec.default;
    }
    const configHash = computeConfigHashSync(cfg);
    const preset: Preset = {
      uiHash: this.uiHash,
      configHash,
      lastSeenAt: Date.now(),
      configuration: cfg,
      ...(trimmed.length > 0 ? { name: trimmed } : {}),
    };
    this.library.set(configHash, preset);
    this.libraryUndo.record({ kind: 'add', record: preset });
    this.emitLibraryChange();
  }

  /**
   * Capture the audible state as a TrajectoryEvent and append it to the
   * log. Called from `wrappedEnd` so every gesture-bracketed change
   * (knob drag, calque drag, click-to-recall, arrow-nav step, recall
   * menu) flows through here. Loop steps are NOT recorded — they're a
   * playback mode, not a user commit.
   */
  private recordTrajectoryCommit(): void {
    const cfg = this.canonicalCurrentConfig();
    const event: TrajectoryEvent = {
      timestampMs: Date.now(),
      configuration: cfg,
    };
    let events = this.trajectory.events.concat(event);
    if (events.length > TRAJECTORY_MAX_EVENTS) {
      events = events.slice(events.length - TRAJECTORY_MAX_EVENTS);
    }
    const headIndex = events.length - 1;
    this.trajectory = {
      uiHash: this.uiHash,
      events,
      headIndex,
      cursorIndex: headIndex,
      updatedAt: Date.now(),
    };
    this.onCommitUser?.(cfg);
    this.onTrajectoryChangeUser?.(this.snapshotTrajectory());
  }

  private canonicalCurrentConfig(): Record<string, number> {
    const params = this.inner.getParamValues();
    const cfg: Record<string, number> = {};
    for (const spec of this.paramSpecs) {
      cfg[spec.address] = params[spec.address] ?? spec.default;
    }
    return cfg;
  }

  private snapshotTrajectory(): TrajectoryRecord {
    return {
      uiHash: this.trajectory.uiHash,
      events: this.trajectory.events.map((e) => ({
        timestampMs: e.timestampMs,
        configuration: { ...e.configuration },
        ...(e.transitionTimeMs !== undefined ? { transitionTimeMs: e.transitionTimeMs } : {}),
        ...(e.transitionLevel !== undefined ? { transitionLevel: e.transitionLevel } : {}),
        ...(e.loopContext !== undefined ? { loopContext: e.loopContext } : {}),
      })),
      headIndex: this.trajectory.headIndex,
      cursorIndex: this.trajectory.cursorIndex,
      updatedAt: this.trajectory.updatedAt,
    };
  }

  private updatePresetsBadge(): void {
    const total = this.library.size;
    const sel = this.selection.length;
    // Write the count to the inner label only — touching the wrap's
    // textContent would wipe the overlaid <select>.
    this.presetsCountLabel.textContent = sel > 0 ? `${sel}/${total}` : String(total);
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

  /**
   * Long-press detection on the Random and Zoom toolbar buttons. At
   * narrow widths (container query in CSS) the dropdowns collapse to
   * icon-only; this handler routes:
   *   • short tap on Random → falls through to FaustOrbitUI / calque so
   *     the random action fires with the current mix value,
   *   • short tap on the Zoom icon → cycle to the next zoom level,
   *   • long press on either → open the native select picker.
   * At wider widths, the dropdowns are visible and used directly; the
   * long-press still works as a redundant access path.
   */
  private installNarrowToolbarHandlers(): void {
    const LONG_PRESS_MS = 400;
    const randomBtn = this.container.querySelector<HTMLElement>('.orbit-random-btn');
    const randomMix = this.container.querySelector<HTMLSelectElement>('.orbit-random-mix');
    const zoomLabel = this.container.querySelector<HTMLElement>('.orbit-zoom-label');
    const zoomSelect = this.container.querySelector<HTMLSelectElement>('.orbit-zoom');

    const bindLongPress = (
      target: HTMLElement,
      select: HTMLSelectElement,
      onShortClick: ((e: MouseEvent) => void) | null,
    ): void => {
      let pressedAt = 0;
      let timer: number | null = null;
      let firedLong = false;
      target.addEventListener('pointerdown', (e) => {
        if (e.button !== 0) return;
        pressedAt = performance.now();
        firedLong = false;
        timer = window.setTimeout(() => {
          firedLong = true;
          timer = null;
          // Open the same theme-styled dropdown the wide mode uses,
          // anchored under the icon button.
          openDropdownMenu({
            anchor: target,
            items: Array.from(select.options)
              .filter((o) => !o.hidden)
              .map((o) => ({
                kind: 'option' as const,
                value: o.value,
                label: o.textContent ?? '',
                disabled: o.disabled,
                active: o.selected,
              })),
            onPick: (value) => {
              select.value = value;
              select.dispatchEvent(new Event('change', { bubbles: true }));
            },
          });
        }, LONG_PRESS_MS);
      });
      const cancel = (): void => {
        if (timer !== null) { clearTimeout(timer); timer = null; }
      };
      target.addEventListener('pointerup', (e) => {
        const heldFor = performance.now() - pressedAt;
        cancel();
        if (firedLong) {
          // Suppress the click that would otherwise follow.
          e.preventDefault();
          e.stopPropagation();
          return;
        }
        if (heldFor >= LONG_PRESS_MS) return;
        onShortClick?.(e);
      });
      target.addEventListener('pointercancel', cancel);
      target.addEventListener('pointerleave', cancel);
      // Suppress the auto-fired click after a long-press.
      target.addEventListener('click', (e) => {
        if (firedLong) {
          firedLong = false;
          e.preventDefault();
          e.stopPropagation();
        }
      }, true);
    };

    if (randomBtn && randomMix) {
      // Random short-click already does the right thing through the
      // native button click handler (FaustOrbitUI's random or the
      // calque's intercept), so we don't need a custom short-click.
      bindLongPress(randomBtn, randomMix, null);
    }

    if (zoomLabel && zoomSelect) {
      bindLongPress(zoomLabel, zoomSelect, () => {
        // Cycle to the next zoom option, then dispatch a `change` event
        // so the host (FaustOrbitUI or the calque's intercept) applies it.
        const options = Array.from(zoomSelect.options);
        if (options.length === 0) return;
        const cur = options.findIndex((o) => o.value === zoomSelect.value);
        const next = options[(cur + 1) % options.length]!;
        zoomSelect.value = next.value;
        zoomSelect.dispatchEvent(new Event('change', { bubbles: true }));
      });
    }
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

function isTrajectoryEvent(value: unknown): value is TrajectoryEvent {
  if (!value || typeof value !== 'object') return false;
  const v = value as Record<string, unknown>;
  if (typeof v.timestampMs !== 'number') return false;
  if (!v.configuration || typeof v.configuration !== 'object') return false;
  for (const cv of Object.values(v.configuration as Record<string, unknown>)) {
    if (typeof cv !== 'number') return false;
  }
  if (v.transitionTimeMs !== undefined && typeof v.transitionTimeMs !== 'number') return false;
  if (v.transitionLevel !== undefined && v.transitionLevel !== 0 && v.transitionLevel !== 1) return false;
  if (v.loopContext !== undefined && typeof v.loopContext !== 'string') return false;
  return true;
}

function normaliseTrajectoryEvent(e: TrajectoryEvent): TrajectoryEvent {
  return {
    timestampMs: e.timestampMs,
    configuration: { ...e.configuration },
    ...(e.transitionTimeMs !== undefined ? { transitionTimeMs: e.transitionTimeMs } : {}),
    ...(e.transitionLevel !== undefined ? { transitionLevel: e.transitionLevel } : {}),
    ...(e.loopContext !== undefined ? { loopContext: e.loopContext } : {}),
  };
}

function clampIndex(idx: unknown, len: number): number {
  if (typeof idx !== 'number' || !Number.isFinite(idx)) return -1;
  if (len === 0) return -1;
  return Math.max(-1, Math.min(len - 1, Math.floor(idx)));
}

function isSelectionEntry(value: unknown): value is SelectionEntry {
  if (!value || typeof value !== 'object') return false;
  const v = value as Record<string, unknown>;
  return typeof v.position === 'number'
    && typeof v.uiHash === 'string'
    && typeof v.configHash === 'string';
}
