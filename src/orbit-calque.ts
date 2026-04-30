/**
 * OrbitCalque — niveau-1 overlay that projects the preset library onto a 2D
 * plane (PCA) and lets the user navigate by clicking presets or dragging
 * a centre marker (Shepard interpolation).
 *
 * Step 2.A: read-only navigation (recall + Shepard).
 * Step 2.B.2: multi-selection (shift+click toggle, shift+drag marquee) and
 *             trash button — emits onSelectionChange / onTrashSelected up
 *             to OrbitUI which mutates the library cache.
 */
import {
  computeProjection,
  projectConfig,
  shepardInterpolate,
  type ParamSpec,
  type Projection,
} from './orbit-projection.js';
import type { Preset } from './orbit-types.js';

const DISK_RADIUS_PX = 8;
const POINT_HIT_RADIUS_PX = 13;
const CENTER_RADIUS_PX = 8;
const CENTER_HIT_RADIUS_PX = 14;
const MARGIN_PX = 24;
const NAMED_HALO_RADIUS_PX = 11;
const SELECTION_RING_RADIUS_PX = 13;
const HALF_LIFE_DAYS = 7;
const HALF_LIFE_MS = HALF_LIFE_DAYS * 24 * 3600 * 1000;

type Bounds = { minX: number; minY: number; maxX: number; maxY: number };
type DragMode = 'none' | 'centre' | 'marquee';

export type OrbitCalqueOptions = {
  /** Container that already hosts the FaustOrbitUI DOM (the orbit-ui-root). */
  container: HTMLElement;
  /** Param specs derived from the Faust UI signature. */
  paramSpecs: ReadonlyArray<ParamSpec>;
  /** Read the audible parameter state (used at toggle-on so the centre
   *  starts where the user already is — no audio jump). */
  getCurrentParams: () => Record<string, number>;
  /** Apply a configuration: pushed continuously during a Shepard drag and
   *  once on a click-to-recall. */
  onApply: (configuration: Record<string, number>) => void;
  /** Selection mutated from inside the calque. The calque emits the
   *  current ordered list of selected configHashes; OrbitUI is in charge
   *  of mapping them to SelectionEntry shapes for the host. */
  onSelectionChange?: (configHashes: ReadonlyArray<string>) => void;
  /** User clicked the trash button (or pressed Delete/Backspace). Caller
   *  is expected to delete the selected presets from the library and
   *  push the cleared selection back via setSelection. */
  onTrashSelected?: () => void;
  /** User submitted a new name for a preset (double-click rename).
   *  Empty / whitespace-only `name` strips the existing name (returns
   *  the preset to anonymous status). The host applies the change to
   *  the library entry and pushes the result back via setLibrary. */
  onPresetRename?: (configHash: string, name: string) => void;
  /** Optional gesture bracketing for host autosave / undo. */
  onInteractionStart?: () => void;
  onInteractionEnd?: () => void;
};

export class OrbitCalque {
  private readonly container: HTMLElement;
  private readonly orbitBody: HTMLElement;
  private readonly overlay: HTMLDivElement;
  private readonly canvas: HTMLCanvasElement;
  private readonly ctx: CanvasRenderingContext2D;
  private readonly trashButton: HTMLButtonElement;
  private readonly nameInput: HTMLInputElement;
  private readonly paramSpecs: ReadonlyArray<ParamSpec>;
  private readonly getCurrentParams: () => Record<string, number>;
  private readonly onApply: (cfg: Record<string, number>) => void;
  private readonly onSelectionChangeCb: ((hashes: ReadonlyArray<string>) => void) | null;
  private readonly onTrashSelectedCb: (() => void) | null;
  private readonly onPresetRenameCb: ((configHash: string, name: string) => void) | null;
  private readonly onInteractionStart: (() => void) | null;
  private readonly onInteractionEnd: (() => void) | null;
  private readonly resizeObs: ResizeObserver;
  /** configHash of the preset whose name is currently being edited. */
  private editingHash: string | null = null;

  private library: ReadonlyArray<Preset> = [];
  /** Insertion-ordered set of selected configHashes. */
  private selection: Set<string> = new Set();
  private visible: boolean = false;
  private projection: Projection | null = null;
  private positions: ReadonlyArray<readonly [number, number]> = [];
  private bounds: Bounds | null = null;
  private centerProj: readonly [number, number] | null = null;
  private dragMode: DragMode = 'none';
  /** Marquee rectangle in canvas (CSS-pixel) coordinates. */
  private marquee: { startX: number; startY: number; endX: number; endY: number } | null = null;
  private rafId: number | null = null;

  constructor(opts: OrbitCalqueOptions) {
    this.container = opts.container;
    this.paramSpecs = opts.paramSpecs;
    this.getCurrentParams = opts.getCurrentParams;
    this.onApply = opts.onApply;
    this.onSelectionChangeCb = opts.onSelectionChange ?? null;
    this.onTrashSelectedCb = opts.onTrashSelected ?? null;
    this.onPresetRenameCb = opts.onPresetRename ?? null;
    this.onInteractionStart = opts.onInteractionStart ?? null;
    this.onInteractionEnd = opts.onInteractionEnd ?? null;

    const body = this.container.querySelector<HTMLElement>('.orbit-body');
    if (!body) {
      throw new Error('OrbitCalque: .orbit-body not found inside container');
    }
    this.orbitBody = body;

    this.overlay = document.createElement('div');
    this.overlay.className = 'orbit-ui-overlay';
    this.overlay.style.display = 'none';
    // Focusable so Cmd+Z routing (host) sees it via document.activeElement.
    this.overlay.tabIndex = 0;

    this.canvas = document.createElement('canvas');
    this.canvas.className = 'orbit-ui-overlay-canvas';
    this.overlay.appendChild(this.canvas);

    this.trashButton = document.createElement('button');
    this.trashButton.type = 'button';
    this.trashButton.className = 'orbit-ui-overlay-trash';
    this.trashButton.title = 'Delete selected presets (Delete)';
    this.trashButton.textContent = '\u{1F5D1}';
    this.trashButton.disabled = true;
    this.trashButton.addEventListener('click', () => this.requestTrash());
    this.overlay.appendChild(this.trashButton);

    this.nameInput = document.createElement('input');
    this.nameInput.type = 'text';
    this.nameInput.className = 'orbit-ui-overlay-name-input';
    this.nameInput.style.display = 'none';
    this.nameInput.addEventListener('keydown', this.handleNameKeyDown);
    this.nameInput.addEventListener('blur', this.handleNameBlur);
    this.overlay.appendChild(this.nameInput);

    this.canvas.addEventListener('dblclick', this.handleDoubleClick);

    this.orbitBody.appendChild(this.overlay);

    const ctx = this.canvas.getContext('2d');
    if (!ctx) throw new Error('OrbitCalque: 2D context unavailable');
    this.ctx = ctx;

    this.canvas.addEventListener('pointerdown', this.handlePointerDown);
    this.canvas.addEventListener('pointermove', this.handlePointerMove);
    this.canvas.addEventListener('pointerup', this.handlePointerUp);
    this.canvas.addEventListener('pointercancel', this.handlePointerUp);

    this.resizeObs = new ResizeObserver(() => {
      if (this.visible) this.scheduleRender();
    });
    this.resizeObs.observe(this.orbitBody);
  }

  setLibrary(records: ReadonlyArray<Preset>): void {
    this.library = records;
    // Drop selection entries that no longer reference an existing preset.
    let pruned = false;
    const known = new Set(records.map((p) => p.configHash));
    for (const h of this.selection) {
      if (!known.has(h)) { this.selection.delete(h); pruned = true; }
    }
    if (pruned) this.updateTrashButton();
    if (this.visible) {
      this.recomputeProjection();
      this.scheduleRender();
    }
  }

  /** Push the selection from outside (host sync, OrbitUI replay). Does
   *  NOT emit onSelectionChange. */
  setSelection(configHashes: ReadonlyArray<string>): void {
    this.selection = new Set(configHashes);
    this.updateTrashButton();
    if (this.visible) this.scheduleRender();
  }

  isVisible(): boolean { return this.visible; }

  toggle(): void {
    if (this.visible) this.hide();
    else this.show();
  }

  show(): void {
    if (this.visible) return;
    this.visible = true;
    this.overlay.style.display = '';
    this.overlay.classList.add('orbit-ui-overlay-active');
    this.recomputeProjection();
    if (this.projection) {
      this.centerProj = projectConfig(this.getCurrentParams(), this.projection);
      this.expandBoundsForCenter();
    }
    this.scheduleRender();
    // Move focus into the overlay so the host's Cmd+Z routing sees it.
    this.overlay.focus({ preventScroll: true });
  }

  hide(): void {
    if (!this.visible) return;
    this.cancelNameEditing();
    this.visible = false;
    this.overlay.classList.remove('orbit-ui-overlay-active');
    this.overlay.style.display = 'none';
    this.dragMode = 'none';
    this.marquee = null;
  }

  /** Triggered by the host (OrbitUI) when Delete/Backspace is pressed
   *  while the calque has focus. Equivalent to clicking the trash button. */
  trashSelected(): void {
    this.requestTrash();
  }

  destroy(): void {
    this.canvas.removeEventListener('pointerdown', this.handlePointerDown);
    this.canvas.removeEventListener('pointermove', this.handlePointerMove);
    this.canvas.removeEventListener('pointerup', this.handlePointerUp);
    this.canvas.removeEventListener('pointercancel', this.handlePointerUp);
    this.canvas.removeEventListener('dblclick', this.handleDoubleClick);
    this.nameInput.removeEventListener('keydown', this.handleNameKeyDown);
    this.nameInput.removeEventListener('blur', this.handleNameBlur);
    this.resizeObs.disconnect();
    if (this.rafId !== null) cancelAnimationFrame(this.rafId);
    this.overlay.remove();
  }

  // ------------------------------------------------------------------------

  private recomputeProjection(): void {
    this.projection = computeProjection(this.library, this.paramSpecs);
    this.positions = this.library.map((p) =>
      projectConfig(p.configuration, this.projection!),
    );
    this.bounds = computeBounds(this.positions);
  }

  private expandBoundsForCenter(): void {
    if (!this.centerProj) return;
    if (!this.bounds) {
      this.bounds = {
        minX: this.centerProj[0], maxX: this.centerProj[0],
        minY: this.centerProj[1], maxY: this.centerProj[1],
      };
      return;
    }
    this.bounds = {
      minX: Math.min(this.bounds.minX, this.centerProj[0]),
      maxX: Math.max(this.bounds.maxX, this.centerProj[0]),
      minY: Math.min(this.bounds.minY, this.centerProj[1]),
      maxY: Math.max(this.bounds.maxY, this.centerProj[1]),
    };
  }

  private scheduleRender(): void {
    if (this.rafId !== null) return;
    this.rafId = requestAnimationFrame(() => {
      this.rafId = null;
      this.render();
    });
  }

  private render(): void {
    const dpr = window.devicePixelRatio || 1;
    const cssW = this.orbitBody.clientWidth;
    const cssH = this.orbitBody.clientHeight;
    if (cssW <= 0 || cssH <= 0) return;
    if (this.canvas.width !== Math.floor(cssW * dpr) ||
        this.canvas.height !== Math.floor(cssH * dpr)) {
      this.canvas.width = Math.floor(cssW * dpr);
      this.canvas.height = Math.floor(cssH * dpr);
    }
    this.canvas.style.width = `${cssW}px`;
    this.canvas.style.height = `${cssH}px`;
    const ctx = this.ctx;
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.clearRect(0, 0, cssW, cssH);

    ctx.fillStyle = 'rgba(13, 16, 22, 0.78)';
    ctx.fillRect(0, 0, cssW, cssH);

    if (!this.projection || !this.bounds) {
      this.drawHint(ctx, cssW, cssH, 'Library is empty');
      this.drawMarquee(ctx);
      return;
    }

    const map = makeProjToCanvas(this.bounds, cssW, cssH);
    const now = Date.now();

    for (let i = 0; i < this.library.length; i += 1) {
      const preset = this.library[i]!;
      const pos = this.positions[i]!;
      const px = map.x(pos[0]);
      const py = map.y(pos[1]);
      const lum = lastSeenLuminosity(preset.lastSeenAt, now);
      const named = typeof preset.name === 'string' && preset.name.length > 0;
      const selected = this.selection.has(preset.configHash);
      if (selected) {
        ctx.beginPath();
        ctx.arc(px, py, SELECTION_RING_RADIUS_PX, 0, Math.PI * 2);
        ctx.strokeStyle = 'rgba(122, 215, 255, 0.95)';
        ctx.lineWidth = 2;
        ctx.stroke();
      }
      if (named) {
        ctx.beginPath();
        ctx.arc(px, py, NAMED_HALO_RADIUS_PX, 0, Math.PI * 2);
        ctx.strokeStyle = 'rgba(232, 197, 98, 0.85)';
        ctx.lineWidth = 1.5;
        ctx.stroke();
      }
      ctx.beginPath();
      ctx.arc(px, py, DISK_RADIUS_PX, 0, Math.PI * 2);
      ctx.fillStyle = `rgb(${lum}, ${lum}, ${lum})`;
      ctx.fill();
      ctx.lineWidth = 1;
      ctx.strokeStyle = 'rgba(255, 255, 255, 0.18)';
      ctx.stroke();
    }

    if (this.centerProj) {
      const cx = map.x(this.centerProj[0]);
      const cy = map.y(this.centerProj[1]);
      ctx.strokeStyle = '#7ad7ff';
      ctx.lineWidth = 2;
      ctx.beginPath();
      ctx.moveTo(cx - CENTER_RADIUS_PX, cy);
      ctx.lineTo(cx + CENTER_RADIUS_PX, cy);
      ctx.moveTo(cx, cy - CENTER_RADIUS_PX);
      ctx.lineTo(cx, cy + CENTER_RADIUS_PX);
      ctx.stroke();
      ctx.beginPath();
      ctx.arc(cx, cy, CENTER_RADIUS_PX, 0, Math.PI * 2);
      ctx.stroke();
    }

    this.drawMarquee(ctx);

    if (this.library.length === 0) {
      this.drawHint(ctx, cssW, cssH, 'Library is empty');
    }
  }

  private drawMarquee(ctx: CanvasRenderingContext2D): void {
    const m = this.marquee;
    if (!m) return;
    const x = Math.min(m.startX, m.endX);
    const y = Math.min(m.startY, m.endY);
    const w = Math.abs(m.endX - m.startX);
    const h = Math.abs(m.endY - m.startY);
    ctx.fillStyle = 'rgba(122, 215, 255, 0.10)';
    ctx.fillRect(x, y, w, h);
    ctx.strokeStyle = 'rgba(122, 215, 255, 0.85)';
    ctx.lineWidth = 1;
    ctx.setLineDash([4, 3]);
    ctx.strokeRect(x, y, w, h);
    ctx.setLineDash([]);
  }

  private drawHint(ctx: CanvasRenderingContext2D, w: number, h: number, msg: string): void {
    ctx.fillStyle = 'rgba(185, 204, 223, 0.85)';
    ctx.font = '13px system-ui, -apple-system, sans-serif';
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    ctx.fillText(msg, w / 2, h / 2);
  }

  // ------------------------------------------------------------------------

  private canvasToProj(clientX: number, clientY: number): readonly [number, number] | null {
    if (!this.bounds) return null;
    const rect = this.canvas.getBoundingClientRect();
    const px = clientX - rect.left;
    const py = clientY - rect.top;
    const map = makeProjToCanvas(this.bounds, rect.width, rect.height);
    return [map.invX(px), map.invY(py)];
  }

  private hitTestPreset(clientX: number, clientY: number): number {
    if (!this.bounds) return -1;
    const rect = this.canvas.getBoundingClientRect();
    const px = clientX - rect.left;
    const py = clientY - rect.top;
    const map = makeProjToCanvas(this.bounds, rect.width, rect.height);
    let best = -1;
    let bestD = POINT_HIT_RADIUS_PX;
    for (let i = 0; i < this.positions.length; i += 1) {
      const pos = this.positions[i]!;
      const dx = map.x(pos[0]) - px;
      const dy = map.y(pos[1]) - py;
      const d = Math.hypot(dx, dy);
      if (d <= bestD) { bestD = d; best = i; }
    }
    return best;
  }

  private hitTestCentre(clientX: number, clientY: number): boolean {
    if (!this.centerProj || !this.bounds) return false;
    const rect = this.canvas.getBoundingClientRect();
    const px = clientX - rect.left;
    const py = clientY - rect.top;
    const map = makeProjToCanvas(this.bounds, rect.width, rect.height);
    const cx = map.x(this.centerProj[0]);
    const cy = map.y(this.centerProj[1]);
    return Math.hypot(cx - px, cy - py) <= CENTER_HIT_RADIUS_PX;
  }

  private canvasPoint(clientX: number, clientY: number): { x: number; y: number } {
    const rect = this.canvas.getBoundingClientRect();
    return { x: clientX - rect.left, y: clientY - rect.top };
  }

  private handlePointerDown = (e: PointerEvent): void => {
    if (!this.visible || !this.projection) return;
    e.preventDefault();
    this.canvas.setPointerCapture(e.pointerId);

    if (e.shiftKey) {
      // Shift+click on a preset → toggle in selection. Else → start marquee.
      const presetIdx = this.hitTestPreset(e.clientX, e.clientY);
      if (presetIdx >= 0) {
        const preset = this.library[presetIdx]!;
        this.toggleInSelection(preset.configHash);
        return;
      }
      const p = this.canvasPoint(e.clientX, e.clientY);
      this.dragMode = 'marquee';
      this.marquee = { startX: p.x, startY: p.y, endX: p.x, endY: p.y };
      this.scheduleRender();
      return;
    }

    const presetIdx = this.hitTestPreset(e.clientX, e.clientY);
    if (presetIdx >= 0) {
      const preset = this.library[presetIdx]!;
      const pos = this.positions[presetIdx]!;
      this.centerProj = pos;
      this.onInteractionStart?.();
      this.onApply(completeConfig(preset.configuration, this.paramSpecs));
      this.onInteractionEnd?.();
      this.scheduleRender();
      return;
    }

    const proj = this.canvasToProj(e.clientX, e.clientY);
    if (!proj) return;
    if (!this.hitTestCentre(e.clientX, e.clientY)) {
      this.centerProj = proj;
    }
    this.dragMode = 'centre';
    this.onInteractionStart?.();
    this.applyCentre();
    this.scheduleRender();
  };

  private handlePointerMove = (e: PointerEvent): void => {
    if (this.dragMode === 'centre') {
      const proj = this.canvasToProj(e.clientX, e.clientY);
      if (!proj) return;
      this.centerProj = proj;
      this.applyCentre();
      this.scheduleRender();
      return;
    }
    if (this.dragMode === 'marquee' && this.marquee) {
      const p = this.canvasPoint(e.clientX, e.clientY);
      this.marquee = { ...this.marquee, endX: p.x, endY: p.y };
      this.scheduleRender();
    }
  };

  private handlePointerUp = (e: PointerEvent): void => {
    if (this.canvas.hasPointerCapture(e.pointerId)) {
      this.canvas.releasePointerCapture(e.pointerId);
    }
    if (this.dragMode === 'centre') {
      this.dragMode = 'none';
      this.onInteractionEnd?.();
      return;
    }
    if (this.dragMode === 'marquee' && this.marquee) {
      this.finalizeMarquee();
      this.marquee = null;
      this.dragMode = 'none';
      this.scheduleRender();
    }
  };

  private finalizeMarquee(): void {
    const m = this.marquee;
    if (!m || !this.bounds) return;
    const x0 = Math.min(m.startX, m.endX);
    const x1 = Math.max(m.startX, m.endX);
    const y0 = Math.min(m.startY, m.endY);
    const y1 = Math.max(m.startY, m.endY);
    const rect = this.canvas.getBoundingClientRect();
    const map = makeProjToCanvas(this.bounds, rect.width, rect.height);
    let mutated = false;
    for (let i = 0; i < this.library.length; i += 1) {
      const pos = this.positions[i]!;
      const cx = map.x(pos[0]);
      const cy = map.y(pos[1]);
      if (cx >= x0 && cx <= x1 && cy >= y0 && cy <= y1) {
        const hash = this.library[i]!.configHash;
        if (!this.selection.has(hash)) {
          this.selection.add(hash);
          mutated = true;
        }
      }
    }
    if (mutated) this.emitSelection();
  }

  private toggleInSelection(configHash: string): void {
    if (this.selection.has(configHash)) this.selection.delete(configHash);
    else this.selection.add(configHash);
    this.emitSelection();
    this.scheduleRender();
  }

  private emitSelection(): void {
    this.updateTrashButton();
    this.onSelectionChangeCb?.(Array.from(this.selection));
  }

  private updateTrashButton(): void {
    this.trashButton.disabled = this.selection.size === 0;
  }

  private requestTrash(): void {
    if (this.selection.size === 0) return;
    this.onTrashSelectedCb?.();
  }

  private applyCentre(): void {
    if (!this.centerProj) return;
    const cfg = shepardInterpolate(
      this.centerProj,
      this.library,
      this.positions,
      this.paramSpecs,
    );
    this.onApply(cfg);
  }

  private handleDoubleClick = (e: MouseEvent): void => {
    if (!this.visible || !this.bounds) return;
    if (e.shiftKey) return;
    const idx = this.hitTestPreset(e.clientX, e.clientY);
    if (idx < 0) return;
    e.preventDefault();
    e.stopPropagation();
    this.startNameEditing(idx);
  };

  private startNameEditing(presetIndex: number): void {
    if (!this.bounds) return;
    const preset = this.library[presetIndex];
    const pos = this.positions[presetIndex];
    if (!preset || !pos) return;
    this.editingHash = preset.configHash;
    const rect = this.canvas.getBoundingClientRect();
    const map = makeProjToCanvas(this.bounds, rect.width, rect.height);
    const px = map.x(pos[0]);
    const py = map.y(pos[1]);
    const inputW = 140;
    this.nameInput.style.display = '';
    this.nameInput.style.left = `${Math.round(px - inputW / 2)}px`;
    this.nameInput.style.top = `${Math.round(py + DISK_RADIUS_PX + 8)}px`;
    this.nameInput.style.width = `${inputW}px`;
    this.nameInput.value = preset.name ?? '';
    this.nameInput.placeholder = 'Preset name (empty to clear)';
    this.nameInput.focus();
    this.nameInput.select();
  }

  private handleNameKeyDown = (e: KeyboardEvent): void => {
    if (e.key === 'Enter') {
      e.preventDefault();
      this.commitNameEditing();
      return;
    }
    if (e.key === 'Escape') {
      e.preventDefault();
      this.cancelNameEditing();
      return;
    }
    // Stop other handlers (calque shortcuts, host Cmd+Z) while typing.
    e.stopPropagation();
  };

  private handleNameBlur = (): void => {
    if (this.editingHash !== null) this.commitNameEditing();
  };

  private commitNameEditing(): void {
    const hash = this.editingHash;
    if (hash === null) return;
    const value = this.nameInput.value.trim();
    this.editingHash = null;
    this.nameInput.style.display = 'none';
    this.onPresetRenameCb?.(hash, value);
  }

  private cancelNameEditing(): void {
    if (this.editingHash === null) return;
    this.editingHash = null;
    this.nameInput.style.display = 'none';
  }
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function completeConfig(
  source: Readonly<Record<string, number>>,
  paramSpecs: ReadonlyArray<ParamSpec>,
): Record<string, number> {
  const out: Record<string, number> = {};
  for (const spec of paramSpecs) {
    out[spec.address] = source[spec.address] ?? spec.default;
  }
  return out;
}

function computeBounds(points: ReadonlyArray<readonly [number, number]>): Bounds | null {
  if (points.length === 0) return null;
  let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
  for (const [x, y] of points) {
    if (x < minX) minX = x;
    if (y < minY) minY = y;
    if (x > maxX) maxX = x;
    if (y > maxY) maxY = y;
  }
  const span = Math.max(maxX - minX, maxY - minY, 1e-3);
  const cx = (minX + maxX) / 2;
  const cy = (minY + maxY) / 2;
  return {
    minX: cx - span / 2,
    maxX: cx + span / 2,
    minY: cy - span / 2,
    maxY: cy + span / 2,
  };
}

function makeProjToCanvas(b: Bounds, w: number, h: number) {
  const innerW = Math.max(1, w - 2 * MARGIN_PX);
  const innerH = Math.max(1, h - 2 * MARGIN_PX);
  const spanX = b.maxX - b.minX || 1;
  const spanY = b.maxY - b.minY || 1;
  const scale = Math.min(innerW / spanX, innerH / spanY);
  const cx = (b.minX + b.maxX) / 2;
  const cy = (b.minY + b.maxY) / 2;
  const cw = w / 2;
  const ch = h / 2;
  return {
    x(px: number): number { return cw + (px - cx) * scale; },
    y(py: number): number { return ch + (py - cy) * scale; },
    invX(x: number): number { return (x - cw) / scale + cx; },
    invY(y: number): number { return (y - ch) / scale + cy; },
  };
}

function lastSeenLuminosity(lastSeenAt: number, now: number): number {
  const age = Math.max(0, now - lastSeenAt);
  const decay = Math.exp(-age / HALF_LIFE_MS * Math.LN2);
  return Math.round(80 + decay * (235 - 80));
}
