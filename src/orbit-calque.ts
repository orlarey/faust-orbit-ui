/**
 * OrbitCalque — niveau-1 overlay that projects the preset library onto a 2D
 * plane (PCA) and lets the user navigate by clicking presets or dragging
 * a centre marker (Shepard interpolation).
 *
 * Step 2.A scope: read-only over the library cache. Library mutations
 * (auto-promotion, naming, deletion, multi-selection, undo) are out of
 * scope and land in subsequent increments.
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
const HALF_LIFE_DAYS = 7;
const HALF_LIFE_MS = HALF_LIFE_DAYS * 24 * 3600 * 1000;

type Bounds = { minX: number; minY: number; maxX: number; maxY: number };

export type OrbitCalqueOptions = {
  /** Container that already hosts the FaustOrbitUI DOM (the orbit-ui-root). */
  container: HTMLElement;
  /** Param specs derived from the Faust UI signature. */
  paramSpecs: ReadonlyArray<ParamSpec>;
  /** Read the audible parameter state (used at toggle-on so the centre
   *  starts where the user already is — no audio jump). */
  getCurrentParams: () => Record<string, number>;
  /** Apply a configuration: pushed continuously during a Shepard drag and
   *  once on a click-to-recall. The calque trusts the host to mirror this
   *  to the audio runtime AND to update the inner orbit-ui's param values. */
  onApply: (configuration: Record<string, number>) => void;
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
  private readonly paramSpecs: ReadonlyArray<ParamSpec>;
  private readonly getCurrentParams: () => Record<string, number>;
  private readonly onApply: (cfg: Record<string, number>) => void;
  private readonly onInteractionStart: (() => void) | null;
  private readonly onInteractionEnd: (() => void) | null;
  private readonly resizeObs: ResizeObserver;

  private library: ReadonlyArray<Preset> = [];
  private visible: boolean = false;
  private projection: Projection | null = null;
  private positions: ReadonlyArray<readonly [number, number]> = [];
  private bounds: Bounds | null = null;
  private centerProj: readonly [number, number] | null = null;
  private dragging: boolean = false;
  private rafId: number | null = null;

  constructor(opts: OrbitCalqueOptions) {
    this.container = opts.container;
    this.paramSpecs = opts.paramSpecs;
    this.getCurrentParams = opts.getCurrentParams;
    this.onApply = opts.onApply;
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

    this.canvas = document.createElement('canvas');
    this.canvas.className = 'orbit-ui-overlay-canvas';
    this.overlay.appendChild(this.canvas);
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
    if (this.visible) {
      this.recomputeProjection();
      this.scheduleRender();
    }
  }

  isVisible(): boolean {
    return this.visible;
  }

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
    // Place centre at current audible state — no audio jump on toggle-on.
    if (this.projection) {
      this.centerProj = projectConfig(this.getCurrentParams(), this.projection);
      this.expandBoundsForCenter();
    }
    this.scheduleRender();
  }

  hide(): void {
    if (!this.visible) return;
    this.visible = false;
    this.overlay.classList.remove('orbit-ui-overlay-active');
    this.overlay.style.display = 'none';
    this.dragging = false;
  }

  destroy(): void {
    this.canvas.removeEventListener('pointerdown', this.handlePointerDown);
    this.canvas.removeEventListener('pointermove', this.handlePointerMove);
    this.canvas.removeEventListener('pointerup', this.handlePointerUp);
    this.canvas.removeEventListener('pointercancel', this.handlePointerUp);
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

    // Backdrop tint so the orbit-ui shows through dimmed.
    ctx.fillStyle = 'rgba(13, 16, 22, 0.78)';
    ctx.fillRect(0, 0, cssW, cssH);

    if (!this.projection || !this.bounds) {
      this.drawHint(ctx, cssW, cssH, 'Library is empty');
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

    if (this.library.length === 0) {
      this.drawHint(ctx, cssW, cssH, 'Library is empty');
    }
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

  private handlePointerDown = (e: PointerEvent): void => {
    if (!this.visible || !this.projection) return;
    e.preventDefault();
    this.canvas.setPointerCapture(e.pointerId);

    const presetIdx = this.hitTestPreset(e.clientX, e.clientY);
    if (presetIdx >= 0) {
      // Click-to-recall: snap centre to the preset, apply its configuration.
      const preset = this.library[presetIdx]!;
      const pos = this.positions[presetIdx]!;
      this.centerProj = pos;
      this.onInteractionStart?.();
      this.onApply(completeConfig(preset.configuration, this.paramSpecs));
      this.onInteractionEnd?.();
      this.scheduleRender();
      return;
    }

    // Drag (centre or empty space → start centre drag at pointer).
    const proj = this.canvasToProj(e.clientX, e.clientY);
    if (!proj) return;
    if (!this.hitTestCentre(e.clientX, e.clientY)) {
      this.centerProj = proj;
    }
    this.dragging = true;
    this.onInteractionStart?.();
    this.applyCentre();
    this.scheduleRender();
  };

  private handlePointerMove = (e: PointerEvent): void => {
    if (!this.dragging) return;
    const proj = this.canvasToProj(e.clientX, e.clientY);
    if (!proj) return;
    this.centerProj = proj;
    this.applyCentre();
    this.scheduleRender();
  };

  private handlePointerUp = (e: PointerEvent): void => {
    if (this.canvas.hasPointerCapture(e.pointerId)) {
      this.canvas.releasePointerCapture(e.pointerId);
    }
    if (!this.dragging) return;
    this.dragging = false;
    this.onInteractionEnd?.();
  };

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
  // Pad to a square so the projection isn't squished on one axis.
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
  // Map decay ∈ [0, 1] to luminosity ∈ [80, 235].
  return Math.round(80 + decay * (235 - 80));
}
