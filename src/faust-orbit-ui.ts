import { FaustUICore, type ParamChangeByUI, type ParamValue, type Path } from './faust-core-ui.js';
import {
  isFaustInputWidgetType,
  parseFaustUiControlsFromUnknown,
  type FaustUIItem,
  type FaustInputWidgetType,
  type FaustMenuEntry
} from './faust-ui-parse.js';

export type OrbitWidgetType = FaustInputWidgetType;

// One interactive control rendered as a movable point in the Orbit view.
export type OrbitControl = {
  path: Path; // Unique Faust parameter path (ex: /synth/freq).
  type: OrbitWidgetType; // Faust widget kind, restricted to active/input widgets.
  label: string; // Human-readable name displayed near the point.
  min: number; // Minimum parameter value.
  max: number; // Maximum parameter value.
  step: number; // Quantization step for continuous widgets.
  unit?: string; // Optional unit label from Faust metadata (ex: "Hz", "dB").
  menu?: FaustMenuEntry[]; // Optional menu entries parsed from Faust style metadata.
  menuStyle?: 'menu' | 'radio'; // Presentation hint: 'menu' for dropdown, 'radio' for button group.
  color: string; // Visual color assigned to this control point.
  x: number; // Current x position in Orbit world coordinates.
  y: number; // Current y position in Orbit world coordinates.
  enabled: boolean; // Whether user interaction is enabled for this control.
};

// Minimal numeric range used for value-distance conversions.
type OrbitValueRange = Pick<OrbitControl, 'min' | 'max'>;

// Complete runtime state of the Orbit UI.
export type OrbitState = {
  zoom: number; // Current zoom percentage (100 = nominal scale).
  center: { x: number; y: number }; // Center of the Orbit coordinate system in world coordinates.
  innerRadius: number; // Inner radius (high-value zone).
  outerRadius: number; // Outer radius (low-value zone).
  controls: Record<Path, OrbitControl>; // Controls indexed by Faust path.
};

// Public constructor options for FaustOrbitUI.
export type FaustOrbitUIOptions = {
  title?: string; // Optional panel title shown in the Orbit header.
  onOrbitStateChange?: (state: OrbitState) => void; // Preferred callback notified when Orbit state changes.
  onStateChange?: (state: OrbitState) => void; // Legacy alias for onOrbitStateChange.
  onInteractionStart?: () => void; // Called at the start of pointer/random interactions.
  onInteractionEnd?: () => void; // Called at the end of pointer/random interactions.
  disabledPaths?: Path[]; // Initial set of control paths disabled in Orbit.
  tooltips?: {
    centerButton?: string;
    randomButton?: string;
    randomMix?: string;
    zoomSelect?: string;
    hintSlider?: string;
    hintCenter?: string;
    hintOuter?: string;
  }; // Optional tooltip texts; when omitted, no tooltip is shown.
};

// Loose shape accepted for external Orbit state inputs before normalization.
type OrbitStateInput = {
  zoom?: unknown; // Incoming zoom candidate.
  center?: {
    x?: unknown; // Incoming center x candidate.
    y?: unknown; // Incoming center y candidate.
  } | null; // Incoming center candidate.
  innerRadius?: unknown; // Incoming inner radius candidate.
  outerRadius?: unknown; // Incoming outer radius candidate.
  controls?: Record<string, unknown>; // Incoming controls dictionary candidate.
};

// Loose shape accepted for one external control before normalization.
type OrbitControlInput = {
  path?: unknown; // Incoming path candidate.
  type?: unknown; // Incoming widget type candidate.
  label?: unknown; // Incoming label candidate.
  min?: unknown; // Incoming minimum value candidate.
  max?: unknown; // Incoming maximum value candidate.
  step?: unknown; // Incoming step value candidate.
  color?: unknown; // Incoming color candidate.
  x?: unknown; // Incoming x coordinate candidate.
  y?: unknown; // Incoming y coordinate candidate.
  enabled?: unknown; // Incoming enabled flag candidate.
};

// Interaction modes used during pointer hit-testing and dragging.
type OrbitPointerMode = 'slider' | 'center' | 'outer';
// Parsed Faust input item narrowed to active widgets only.
type OrbitInputItem = FaustUIItem & { type: FaustInputWidgetType };

// Active pointer interaction session state.
type OrbitPointer = {
  pointerId: number; // DOM pointer identifier used for capture and tracking.
  mode: OrbitPointerMode; // Current interaction mode.
  path: Path | null; // Target control path for slider drags, null otherwise.
};

// Hit-test result for the current pointer position.
type OrbitHit = {
  mode: OrbitPointerMode; // Hit mode under the pointer.
  path?: Path; // Control path when mode is slider.
};

// Tooltip information displayed near pointer hover.
type OrbitHoverHint = {
  x: number; // Anchor x coordinate in world space.
  y: number; // Anchor y coordinate in world space.
  text: string; // Tooltip text content.
  accent: string; // Tooltip accent color.
};

// Clamps a number to an inclusive [min, max] range.
function clamp(value: number, min: number, max: number): number {
  return Math.max(min, Math.min(max, value));
}

// Creates a deep clone of OrbitState for safe external reads.
function cloneState(state: OrbitState): OrbitState {
  return {
    zoom: state.zoom,
    center: { x: state.center.x, y: state.center.y },
    innerRadius: state.innerRadius,
    outerRadius: state.outerRadius,
    controls: Object.fromEntries(
      Object.entries(state.controls || {}).map(([path, c]) => [
        path,
        {
          path,
          label: c.label,
          min: c.min,
          max: c.max,
          step: c.step,
          ...(c.unit ? { unit: c.unit } : {}),
          ...(c.menu ? { menu: c.menu.map(e => ({ ...e })) } : {}),
          ...(c.menuStyle ? { menuStyle: c.menuStyle } : {}),
          color: c.color,
          x: c.x,
          y: c.y,
          enabled: !!c.enabled,
          type: c.type || 'hslider'
        }
      ])
    )
  };
}

// Derives a deterministic color from a parameter path.
function colorFromPath(path: string): string {
  let hash = 0;
  for (let i = 0; i < path.length; i += 1) {
    hash = ((hash << 5) - hash + path.charCodeAt(i)) | 0;
  }
  const hue = Math.abs(hash) % 360;
  return `hsl(${hue} 68% 62%)`;
}

// Runtime guard for plain object-like values.
function isRecord(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === 'object';
}

function isOrbitInputItem(item: FaustUIItem): item is OrbitInputItem {
  return isFaustInputWidgetType(item.type);
}

/**
 * ============================================================
 * FaustOrbitUI
 * Orbit-based Faust UI renderer and interaction controller.
 * ============================================================
 */
export class FaustOrbitUI extends FaustUICore {
  private onStateChange: ((state: OrbitState) => void) | null; // Subscriber callback for Orbit state snapshots.
  private onInteractionStart: (() => void) | null; // Optional hook fired when user interaction begins.
  private onInteractionEnd: (() => void) | null; // Optional hook fired when user interaction ends.
  private disabledPaths: Set<Path>; // Set of paths disabled by default in this Orbit instance.
  private controlOrder: Path[]; // Stable order of controls used for angular placement fallback.
  private paramValues: Record<Path, number>; // Last known parameter values, indexed by path.
  private pointer: OrbitPointer | null; // Current pointer drag session state.
  private resizeObserver: ResizeObserver | null; // Resize observer bound to canvas container.
  private rafId: number | null; // Pending requestAnimationFrame id for deferred drawing.
  private lastStateEmitAt: number; // Timestamp of last emitted state notification.
  private stateEmitTimer: ReturnType<typeof setTimeout> | null; // Pending timer id for throttled state emission.
  private baseWidth: number; // Base world width (before zoom scaling).
  private baseHeight: number; // Base world height (before zoom scaling).
  private renderScale: number; // Current world-to-screen scale factor derived from zoom.
  private renderOffsetX: number; // Current x translation applied by zoom transform.
  private renderOffsetY: number; // Current y translation applied by zoom transform.
  private gridOrigin: { x: number; y: number }; // Grid origin used to keep background grid visually stable.
  private initialOuterRadius: number | null; // Reference outer radius used for grid spacing consistency.
  private hoverHint: OrbitHoverHint | null; // Current hover tooltip state, if any.
  private tooltips: NonNullable<FaustOrbitUIOptions['tooltips']>; // Optional tooltip strings injected by host app.

  private state: OrbitState; // Internal authoritative Orbit state.
  private activePath: Path | null; // Path of the last-touched control shown in the detail panel.

  private body: HTMLDivElement; // Root scrollable body containing the canvas.
  private canvas: HTMLCanvasElement; // Drawing canvas for Orbit UI.
  private ctx: CanvasRenderingContext2D; // 2D rendering context of the Orbit canvas.
  private detailEl: HTMLDivElement; // Detail panel container below the canvas.
  private zoomSelect: HTMLSelectElement; // Zoom selector element in Orbit toolbar.
  private centerButton: HTMLButtonElement; // Center action button in Orbit toolbar.
  private randomButton: HTMLButtonElement; // Random action button in Orbit toolbar.
  private randomMixSelect: HTMLSelectElement; // Random mix coefficient selector in Orbit toolbar.
  private zoomHandler: (() => void) | null = null; // Bound zoom change handler for add/removeEventListener symmetry.
  private centerHandler: (() => void) | null = null; // Bound center click handler for add/removeEventListener symmetry.
  private randomHandler: (() => void) | null = null; // Bound random click handler for add/removeEventListener symmetry.
  private keyHandler: ((event: KeyboardEvent) => void) | null = null; // Bound keyboard handler for add/removeEventListener symmetry.

  // Builds and initializes the Orbit UI canvas, toolbar, and interactions.
  constructor(root: HTMLElement, paramChangeByUI: ParamChangeByUI, options: FaustOrbitUIOptions = {}) {
    super(root, paramChangeByUI);
    const title = typeof options.title === 'string' && options.title.trim() ? options.title.trim() : '';
    this.onStateChange =
      typeof options.onOrbitStateChange === 'function'
        ? options.onOrbitStateChange
        : typeof options.onStateChange === 'function'
          ? options.onStateChange
          : null;
    this.onInteractionStart = typeof options.onInteractionStart === 'function' ? options.onInteractionStart : null;
    this.onInteractionEnd = typeof options.onInteractionEnd === 'function' ? options.onInteractionEnd : null;
    this.disabledPaths = new Set(Array.isArray(options.disabledPaths) ? options.disabledPaths : []);
    this.controlOrder = [];
    this.paramValues = {};
    this.pointer = null;
    this.resizeObserver = null;
    this.rafId = null;
    this.lastStateEmitAt = 0;
    this.stateEmitTimer = null;
    this.baseWidth = 1;
    this.baseHeight = 1;
    this.renderScale = 1;
    this.renderOffsetX = 0;
    this.renderOffsetY = 0;
    this.gridOrigin = { x: 0.5, y: 0.5 };
    this.initialOuterRadius = null;
    this.hoverHint = null;
    this.activePath = null;
    this.tooltips = options.tooltips || {};

    this.state = {
      zoom: 100,
      center: { x: 0.5, y: 0.5 },
      innerRadius: 20,
      outerRadius: 90,
      controls: {}
    };

    this.root.innerHTML = `
      <div class="orbit-wrap">
        <div class="orbit-header">
          <span class="orbit-title">Orbit UI</span>
          <div class="orbit-middle-actions">
            <button type="button" class="orbit-center-btn">Center</button>
            <div class="orbit-random-group">
              <button type="button" class="orbit-random-btn">Random</button>
              <select class="orbit-random-mix" aria-label="Random coefficient">
                <option value="0.25">0.25</option>
                <option value="0.5" selected>0.5</option>
                <option value="0.75">0.75</option>
                <option value="1">1</option>
              </select>
            </div>
          </div>
          <div class="orbit-zoom-wrap">
            <div class="orbit-zoom-group" aria-label="Zoom selector">
              <span class="orbit-zoom-label">Zoom</span>
              <select class="orbit-zoom">
                <option value="75">75%</option>
                <option value="100">100%</option>
                <option value="125">125%</option>
                <option value="150">150%</option>
                <option value="200">200%</option>
              </select>
            </div>
          </div>
        </div>
        <div class="orbit-body">
          <canvas class="orbit-canvas"></canvas>
        </div>
        <div class="orbit-detail">
          <span class="orbit-detail-empty">Select a control</span>
        </div>
      </div>
    `;
    this.root.tabIndex = 0;

    const body = this.root.querySelector('.orbit-body');
    const canvas = this.root.querySelector('.orbit-canvas');
    const detailEl = this.root.querySelector('.orbit-detail');
    if (!(body instanceof HTMLDivElement) || !(canvas instanceof HTMLCanvasElement) || !(detailEl instanceof HTMLDivElement)) {
      throw new Error('FaustOrbitUI: invalid orbit DOM');
    }
    this.body = body;
    this.canvas = canvas;
    this.detailEl = detailEl;
    const ctx = this.canvas.getContext('2d');
    const zoomSelect = this.root.querySelector('.orbit-zoom');
    const centerButton = this.root.querySelector('.orbit-center-btn');
    const randomButton = this.root.querySelector('.orbit-random-btn');
    const randomMixSelect = this.root.querySelector('.orbit-random-mix');
    if (!(zoomSelect instanceof HTMLSelectElement) ||
      !(centerButton instanceof HTMLButtonElement) ||
      !(randomButton instanceof HTMLButtonElement) ||
      !(randomMixSelect instanceof HTMLSelectElement)) {
      throw new Error('FaustOrbitUI: invalid orbit toolbar DOM');
    }
    this.zoomSelect = zoomSelect;
    this.centerButton = centerButton;
    this.randomButton = randomButton;
    this.randomMixSelect = randomMixSelect;
    const titleEl = this.root.querySelector('.orbit-title');
    if (titleEl) {
      if (title) {
        titleEl.textContent = title;
      } else {
        (titleEl as HTMLElement).style.display = 'none';
      }
    }
    if (this.tooltips.centerButton) this.centerButton.title = this.tooltips.centerButton;
    if (this.tooltips.randomButton) this.randomButton.title = this.tooltips.randomButton;
    if (this.tooltips.randomMix) this.randomMixSelect.title = this.tooltips.randomMix;
    if (this.tooltips.zoomSelect) this.zoomSelect.title = this.tooltips.zoomSelect;
    if (!ctx) {
      throw new Error('FaustOrbitUI: invalid orbit DOM');
    }
    this.ctx = ctx;

    this._installZoomHandler();
    this._installCenterHandler();
    this._installRandomHandler();
    this._installKeyboardHandler();
    this._installPointerHandlers();
    this._installResizeObserver();

    this.center();
    this._requestRender();
  }

  // Returns the current Orbit state snapshot (FaustUICore compatibility alias).
  getState(): OrbitState {
    return this.getOrbitState();
  }

  // Replaces the Orbit state (FaustUICore compatibility alias).
  setState(state: OrbitState): void {
    this.setOrbitState(state);
  }

  // Returns a cloned Orbit state safe to pass to external callers.
  getOrbitState(): OrbitState {
    return cloneState(this.state);
  }

  // Applies a fully typed Orbit state directly to the renderer.
  setOrbitState(state: OrbitState): void {
    this.state = cloneState(state);
    this.initialOuterRadius = this.state.outerRadius;
    this.controlOrder = Object.keys(this.state.controls);
    this._ensureRadii();
    this._constrainControlPositions();
    this._requestRender();
    this._requestStateEmit();
    this._updateDetailPanel();
  }

  // Validates unknown input, normalizes it, and applies the resulting Orbit state.
  setOrbitStateFromUnknown(input: unknown): void {
    const normalized = this._normalizeState(input);
    if (!normalized) {
      this._warn('invalid_orbit_state', input);
      return;
    }
    this.setOrbitState(normalized);
  }

  // Builds a default OrbitState.controls map from Faust UI JSON metadata.
  buildControls(ui: FaustUIItem[]): OrbitState {
    const controls = ui
      .filter(isOrbitInputItem)
      .map((control) => ({
      ...control,
      color: colorFromPath(control.path)
      }));
    return this.buildControlsFromSpecs(controls);
  }

  // Builds Orbit state from already-normalized control specs.
  private buildControlsFromSpecs(controls: Array<Omit<OrbitControl, 'x' | 'y' | 'enabled'>>): OrbitState {
    const next = this.getOrbitState();
    next.controls = {};
    this.controlOrder = controls.map((c) => c.path);
    const count = Math.max(1, controls.length);
    controls.forEach((control, index) => {
      const previous = this.state.controls[control.path];
      const keepEnabled = previous ? !!previous.enabled : !this.disabledPaths.has(control.path);
      const keepColor = previous && previous.color ? previous.color : control.color;
      const keepLabel = previous && previous.label ? previous.label : control.label;
      const keepStep = Number.isFinite(previous && previous.step) ? previous.step : control.step;

      let x;
      let y;
      if (previous && Number.isFinite(previous.x) && Number.isFinite(previous.y)) {
        x = previous.x;
        y = previous.y;
      } else {
        const angle = (index / count) * Math.PI * 2 - Math.PI / 2;
        const current = Number.isFinite(this.paramValues[control.path]) ? this.paramValues[control.path] : control.min;
        const distance = this._distanceFromValue(control, current, next);
        x = next.center.x + Math.cos(angle) * distance;
        y = next.center.y + Math.sin(angle) * distance;
      }

      const keepUnit = previous && previous.unit ? previous.unit : control.unit;
      const keepMenu = previous && previous.menu ? previous.menu : control.menu;
      const keepMenuStyle = previous && previous.menuStyle ? previous.menuStyle : control.menuStyle;

      next.controls[control.path] = {
        path: control.path,
        type: control.type,
        label: keepLabel,
        min: control.min,
        max: control.max,
        step: keepStep,
        ...(keepUnit ? { unit: keepUnit } : {}),
        ...(keepMenu ? { menu: keepMenu } : {}),
        ...(keepMenuStyle ? { menuStyle: keepMenuStyle } : {}),
        color: keepColor,
        x,
        y,
        enabled: keepEnabled
      };
    });

    return next;
  }

  // Validates unknown Faust UI input and builds a default Orbit state from it.
  buildControlsFromUnknown(input: unknown): OrbitState {
    const parsed = parseFaustUiControlsFromUnknown(input);
    const controls = parsed
      .filter(isOrbitInputItem)
      .map((control) => ({
        ...control,
        color: colorFromPath(control.path)
      }));
    return this.buildControlsFromSpecs(controls);
  }

  // Applies one external parameter value and updates point position when needed.
  setParamValue(path: Path, value: ParamValue): void {
    if (!path || !Number.isFinite(value)) return;
    const control = this.state.controls[path];
    this.paramValues[path] = value;
    if (path === this.activePath) this._updateDetailPanel();
    // During any local drag, point positions are user-authoritative.
    if (this.pointer) return;
    if (!control || !control.enabled) return;
    if (this._isValueCompatibleWithCurrentPosition(control, value)) return;
    const p = this._positionFromValue(path, value);
    if (!p) return;
    control.x = p.x;
    control.y = p.y;
    this._requestRender();
  }

  // Applies a batch of external parameter values atomically.
  setParams(values: Record<Path, ParamValue>): void {
    if (!values || typeof values !== 'object') return;
    this.transaction(() => {
      for (const [path, value] of Object.entries(values)) {
        this.setParamValue(path, value);
      }
    });
  }

  // Sets zoom percentage and updates the viewport transform.
  setZoom(percent: number | string): void {
    const parsed = Number(percent);
    const zoom = Number.isFinite(parsed) ? clamp(Math.round(parsed), 50, 300) : 100;
    if (zoom === this.state.zoom) return;
    this.state.zoom = zoom;
    if (this.zoomSelect && this.zoomSelect.value !== String(zoom)) {
      this.zoomSelect.value = String(zoom);
    }
    this._resizeCanvas({ keepViewportCenter: true });
    this._requestRender();
    this._requestStateEmit();
  }

  // Returns the current zoom percentage.
  getZoom(): number {
    return this.state.zoom;
  }

  // Recomputes canvas size and keeps controls constrained in bounds.
  resize(): void {
    const resized = this._resizeCanvas();
    if (!resized) return;
    this._ensureRadii();
    this._constrainControlPositions();
    this._requestRender();
  }

  // Resets center/radii and redistributes controls to default layout.
  center(): void {
    const { width, height } = this._getBaseSize();
    this.baseWidth = width;
    this.baseHeight = height;
    this.state.center = { x: width / 2, y: height / 2 };
    this.gridOrigin = { x: this.state.center.x, y: this.state.center.y };
    const defaultOuter = Math.max(60, Math.min(width, height) * 0.36);
    this.state.outerRadius = defaultOuter;
    this.initialOuterRadius = defaultOuter;
    this.state.innerRadius = Math.max(14, defaultOuter * 0.18);
    const paths = Object.keys(this.state.controls);
    const count = Math.max(1, paths.length);
    paths.forEach((path, index) => {
      const control = this.state.controls[path];
      const angle = (index / count) * Math.PI * 2 - Math.PI / 2;
      const distance = this._distanceFromValue(control, this.paramValues[path], this.state);
      control.x = this.state.center.x + Math.cos(angle) * distance;
      control.y = this.state.center.y + Math.sin(angle) * distance;
    });
    this._ensureRadii();
    this._constrainControlPositions();
    this._resizeCanvas();
    this._requestRender();
    this._requestStateEmit();
  }

  // Randomizes enabled control values with blend factor c in [0,1].
  random(c: number): void {
    if (this.pointer) return;
    const mix = clamp(c, 0, 1);
    if (this.onInteractionStart) {
      try {
        this.onInteractionStart();
      } catch {
        // ignore
      }
    }
    try {
      this.transaction(() => {
        for (const control of Object.values(this.state.controls)) {
          if (!control.enabled) continue;
          const v0 = Number.isFinite(this.paramValues[control.path])
            ? this.paramValues[control.path]
            : this._valueFromPosition(control, control.x, control.y);
          const randomValue = control.min + Math.random() * (control.max - control.min);
          let v1 = mix * randomValue + (1 - mix) * v0;
          if (control.type !== 'button' && control.type !== 'checkbox' && control.step > 0) {
            const steps = Math.round((v1 - control.min) / control.step);
            v1 = control.min + steps * control.step;
          }
          v1 = clamp(v1, control.min, control.max);
          const p = this._positionFromValue(control.path, v1);
          if (!p) continue;
          control.x = p.x;
          control.y = p.y;
          this._emitValueForControl(control);
        }
        this._requestRender();
        this._requestStateEmit();
      });
    } finally {
      if (this.onInteractionEnd) {
        try {
          this.onInteractionEnd();
        } catch {
          // ignore
        }
      }
    }
  }

  // Removes DOM listeners/observers/timers and releases resources.
  destroy(): void {
    if (this.resizeObserver) {
      this.resizeObserver.disconnect();
      this.resizeObserver = null;
    }
    if (this.canvas) {
      this.canvas.onpointerdown = null;
      this.canvas.onpointermove = null;
      this.canvas.onpointerup = null;
      this.canvas.onpointercancel = null;
      this.canvas.onpointerleave = null;
    }
    if (this.zoomSelect && this.zoomHandler) {
      this.zoomSelect.removeEventListener('change', this.zoomHandler);
    }
    if (this.centerButton && this.centerHandler) {
      this.centerButton.removeEventListener('click', this.centerHandler);
    }
    if (this.randomButton && this.randomHandler) {
      this.randomButton.removeEventListener('click', this.randomHandler);
    }
    if (this.root && this.keyHandler) {
      this.root.removeEventListener('keydown', this.keyHandler);
    }
    if (this.rafId) {
      cancelAnimationFrame(this.rafId);
      this.rafId = null;
    }
    if (this.stateEmitTimer) {
      clearTimeout(this.stateEmitTimer);
      this.stateEmitTimer = null;
    }
    super.destroy();
  }

  // Schedules a single animation-frame render.
  _flushRender(): void {
    if (this.rafId) return;
    this.rafId = requestAnimationFrame(() => {
      this.rafId = null;
      this._drawNow();
    });
  }

  // Emits state change callbacks with basic throttling.
  _emitState(): void {
    if (!this.onStateChange) return;
    const now = Date.now();
    const elapsed = now - this.lastStateEmitAt;
    if (elapsed >= 120) {
      this.lastStateEmitAt = now;
      try {
        this.onStateChange(this.getOrbitState());
      } catch {
        // ignore
      }
      return;
    }
    if (this.stateEmitTimer) return;
    this.stateEmitTimer = setTimeout(() => {
      this.stateEmitTimer = null;
      this.lastStateEmitAt = Date.now();
      try {
        const callback = this.onStateChange;
        if (!callback) return;
        callback(this.getOrbitState());
      } catch {
        // ignore
      }
    }, Math.max(0, 120 - elapsed));
  }

  // Installs the toolbar zoom select handler.
  _installZoomHandler(): void {
    if (!this.zoomSelect) return;
    this.zoomSelect.value = String(this.state.zoom);
    this.zoomHandler = () => {
      this.setZoom(this.zoomSelect.value);
    };
    this.zoomSelect.addEventListener('change', this.zoomHandler);
  }

  // Installs the toolbar center button handler.
  _installCenterHandler(): void {
    if (!this.centerButton) return;
    this.centerHandler = () => {
      this.center();
    };
    this.centerButton.addEventListener('click', this.centerHandler);
  }

  // Installs the toolbar random button handler.
  _installRandomHandler(): void {
    if (!this.randomButton) return;
    this.randomHandler = () => {
      const c = this.randomMixSelect ? Number(this.randomMixSelect.value) : 1;
      this.random(c);
    };
    this.randomButton.addEventListener('click', this.randomHandler);
  }

  // Installs keyboard shortcuts scoped to the Orbit root.
  _installKeyboardHandler(): void {
    this.keyHandler = (event: KeyboardEvent) => {
      if (!event || typeof event.key !== 'string') return;

      // Ignore keyboard shortcuts when a detail panel input has focus.
      const target = event.target;
      if (target instanceof HTMLInputElement && target.closest('.orbit-detail')) return;

      if (event.key.toLowerCase() === 'r') {
        event.preventDefault();
        const c = this.randomMixSelect ? Number(this.randomMixSelect.value) : 1;
        this.random(c);
        return;
      }
      if (event.key === 'ArrowLeft' || event.key === 'ArrowRight') {
        event.preventDefault();
        this._navigateControl(event.key === 'ArrowRight' ? 1 : -1);
        return;
      }
      if (event.key === 'ArrowUp' || event.key === 'ArrowDown') {
        event.preventDefault();
        this._stepActiveControl(event.key === 'ArrowUp' ? 1 : -1);
        return;
      }
      if (event.key === ' ') {
        event.preventDefault();
        this._spaceActiveControl(true);
        return;
      }
    };
    this.root.addEventListener('keydown', this.keyHandler);

    this.root.addEventListener('keyup', (event: KeyboardEvent) => {
      if (event.key === ' ') {
        event.preventDefault();
        this._spaceActiveControl(false);
      }
    });
  }

  // Installs a resize observer and performs initial canvas sizing.
  _installResizeObserver(): void {
    this.resizeObserver = new ResizeObserver(() => this.resize());
    this.resizeObserver.observe(this.canvas);
    this._resizeCanvas();
  }

  // Installs pointer interactions for controls, center, and outer radius ring.
  _installPointerHandlers(): void {
    this.canvas.onpointerdown = (event: PointerEvent) => {
      const p = this._pointerPosition(event);
      const hit = this._hitTest(p.x, p.y);
      if (!hit) return;

      if (hit.mode === 'slider' && hit.path && event.shiftKey) {
        event.preventDefault();
        const control = this.state.controls[hit.path];
        if (!control) return;
        control.enabled = !control.enabled;
        this._requestRender();
        this._requestStateEmit();
        return;
      }

      event.preventDefault();
      this.root.focus();
      this.canvas.setPointerCapture(event.pointerId);
      this.pointer = { pointerId: event.pointerId, mode: hit.mode, path: hit.path || null };
      this.hoverHint = null;
      if (hit.mode === 'slider' && hit.path) {
        this._setActivePath(hit.path);
      }
      if (this.onInteractionStart) {
        try {
          this.onInteractionStart();
        } catch {
          // ignore
        }
      }
      this._updateCursor(this.pointer.mode);
    };

    this.canvas.onpointermove = (event: PointerEvent) => {
      const p = this._pointerPosition(event);
      if (!this.pointer) {
        const hit = this._hitTest(p.x, p.y);
        this._updateHoverHint(hit, p.x, p.y);
        this._updateCursor(hit ? hit.mode : null);
        this._requestRender();
        return;
      }
      if (event.pointerId !== this.pointer.pointerId) return;

      if (this.pointer.mode === 'slider' && this.pointer.path) {
        const control = this.state.controls[this.pointer.path];
        if (!control) return;
        control.x = clamp(p.x, 0, this.baseWidth);
        control.y = clamp(p.y, 0, this.baseHeight);
        this._emitValueForControl(control);
        this._requestRender();
        this._requestStateEmit();
        return;
      }

      if (this.pointer.mode === 'center') {
        this.state.center.x = clamp(p.x, 0, this.baseWidth);
        this.state.center.y = clamp(p.y, 0, this.baseHeight);
        this._emitValuesForAllControls();
        this._requestRender();
        this._requestStateEmit();
        return;
      }

      if (this.pointer.mode === 'outer') {
        this.state.outerRadius = Math.hypot(p.x - this.state.center.x, p.y - this.state.center.y);
        this._ensureRadii();
        this._emitValuesForAllControls();
        this._requestRender();
        this._requestStateEmit();
      }
    };

    const release = (event: PointerEvent) => {
      if (!this.pointer || event.pointerId !== this.pointer.pointerId) return;
      this.pointer = null;
      this._updateCursor(null);
      if (this.onInteractionEnd) {
        try {
          this.onInteractionEnd();
        } catch {
          // ignore
        }
      }
      this._requestStateEmit();
    };

    this.canvas.onpointerup = release;
    this.canvas.onpointercancel = release;
    this.canvas.onpointerleave = () => {
      this.hoverHint = null;
      if (!this.pointer) this._updateCursor(null);
      this._requestRender();
    };
  }

  // Updates the hover tooltip content based on current hit target.
  _updateHoverHint(hit: OrbitHit | null, x: number, y: number): void {
    if (!hit) {
      this.hoverHint = null;
      return;
    }
    if (hit.mode === 'slider' && hit.path) {
      const control = this.state.controls[hit.path];
      if (!control) {
        this.hoverHint = null;
        return;
      }
      if (!this.tooltips.hintSlider) {
        this.hoverHint = null;
        return;
      }
      this.hoverHint = {
        x,
        y,
        text: `${control.label}: ${this.tooltips.hintSlider}`,
        accent: control.enabled ? control.color : 'rgba(160,160,160,0.8)'
      };
      return;
    }
    if (hit.mode === 'center') {
      if (!this.tooltips.hintCenter) {
        this.hoverHint = null;
        return;
      }
      this.hoverHint = {
        x,
        y,
        text: this.tooltips.hintCenter,
        accent: 'rgba(220,220,220,0.9)'
      };
      return;
    }
    if (hit.mode === 'outer') {
      if (!this.tooltips.hintOuter) {
        this.hoverHint = null;
        return;
      }
      this.hoverHint = {
        x,
        y,
        text: this.tooltips.hintOuter,
        accent: 'rgba(220,220,220,0.9)'
      };
      return;
    }
    this.hoverHint = null;
  }

  // Validates and normalizes an incoming state-like object.
  _normalizeState(state: unknown): OrbitState | null {
    if (!isRecord(state)) {
      return null;
    }
    const typedState = state as OrbitStateInput;
    if (!isRecord(typedState.controls)) {
      return null;
    }
    const { width, height } = this._getBaseSize();
    this.baseWidth = width;
    this.baseHeight = height;
    const normalized: OrbitState = {
      zoom: Number.isFinite(typedState.zoom) ? clamp(Number(typedState.zoom), 50, 300) : this.state.zoom || 100,
      center: {
        x: clamp(Number(typedState.center && typedState.center.x) || this.state.center.x || width / 2, 0, width),
        y: clamp(Number(typedState.center && typedState.center.y) || this.state.center.y || height / 2, 0, height)
      },
      innerRadius: Number.isFinite(typedState.innerRadius) ? Number(typedState.innerRadius) : this.state.innerRadius,
      outerRadius: Number.isFinite(typedState.outerRadius) ? Number(typedState.outerRadius) : this.state.outerRadius,
      controls: {}
    };

    for (const [path, rawValue] of Object.entries(typedState.controls)) {
      if (!isRecord(rawValue)) continue;
      const raw = rawValue as OrbitControlInput;
      const min = Number(raw.min);
      const max = Number(raw.max);
      const step = Number(raw.step);
      if (!Number.isFinite(min) || !Number.isFinite(max) || !Number.isFinite(step)) continue;
      if (max <= min) continue;
      const label = String(raw.label || path);
      const color = String(raw.color || colorFromPath(path));
      const inferredType: OrbitWidgetType =
        isFaustInputWidgetType(raw.type)
          ? raw.type
          : (step >= 1 && min === 0 && max === 1 ? 'checkbox' : 'hslider');
      const unit = typeof (raw as Record<string, unknown>).unit === 'string'
        ? (raw as Record<string, unknown>).unit as string
        : undefined;
      const rawMenu = (raw as Record<string, unknown>).menu;
      const menu = Array.isArray(rawMenu) ? rawMenu as FaustMenuEntry[] : undefined;
      const rawMenuStyle = (raw as Record<string, unknown>).menuStyle;
      const menuStyle = rawMenuStyle === 'menu' || rawMenuStyle === 'radio' ? rawMenuStyle : undefined;
      normalized.controls[path] = {
        path,
        type: inferredType,
        label,
        min,
        max,
        step,
        ...(unit ? { unit } : {}),
        ...(menu ? { menu } : {}),
        ...(menuStyle ? { menuStyle } : {}),
        color,
        x: clamp(Number(raw.x) || normalized.center.x, 0, width),
        y: clamp(Number(raw.y) || normalized.center.y, 0, height),
        enabled: !!raw.enabled
      };
    }

    this.zoomSelect.value = String(normalized.zoom);
    if (!this.gridOrigin || !Number.isFinite(this.gridOrigin.x) || !Number.isFinite(this.gridOrigin.y)) {
      this.gridOrigin = { x: normalized.center.x, y: normalized.center.y };
    }
    this._resizeCanvas();
    return normalized;
  }

  // Returns current unscaled viewport size used as world-space bounds.
  _getBaseSize(): { width: number; height: number } {
    const width = Math.max(1, this.body.clientWidth || 1);
    const height = Math.max(1, this.body.clientHeight || 1);
    return { width, height };
  }

  // Resizes canvas and updates world-to-screen transform from zoom.
  _resizeCanvas(options: { keepViewportCenter?: boolean } = {}): boolean {
    const keepViewportCenter = !!options.keepViewportCenter;
    const oldScale = this.renderScale || 1;
    const oldOffsetX = this.renderOffsetX || 0;
    const oldOffsetY = this.renderOffsetY || 0;
    const centerWorldX = ((this.body.scrollLeft + (this.body.clientWidth / 2)) - oldOffsetX) / oldScale;
    const centerWorldY = ((this.body.scrollTop + (this.body.clientHeight / 2)) - oldOffsetY) / oldScale;

    const rawWidth = this.body.clientWidth || 0;
    const rawHeight = this.body.clientHeight || 0;
    if (rawWidth < 2 || rawHeight < 2) return false;

    this.baseWidth = rawWidth;
    this.baseHeight = rawHeight;

    const dpr = window.devicePixelRatio || 1;
    const scale = clamp((this.state.zoom || 100) / 100, 0.5, 3);
    const cssWidth = scale < 1 ? rawWidth : Math.max(1, Math.round(rawWidth * scale));
    const cssHeight = scale < 1 ? rawHeight : Math.max(1, Math.round(rawHeight * scale));
    const offsetX = scale < 1 ? (rawWidth - (rawWidth * scale)) / 2 : 0;
    const offsetY = scale < 1 ? (rawHeight - (rawHeight * scale)) / 2 : 0;

    this.canvas.style.width = `${cssWidth}px`;
    this.canvas.style.height = `${cssHeight}px`;
    this.canvas.width = Math.round((scale < 1 ? rawWidth : cssWidth) * dpr);
    this.canvas.height = Math.round((scale < 1 ? rawHeight : cssHeight) * dpr);

    this.renderScale = scale;
    this.renderOffsetX = offsetX;
    this.renderOffsetY = offsetY;
    this.ctx.setTransform(dpr * scale, 0, 0, dpr * scale, dpr * offsetX, dpr * offsetY);

    if (keepViewportCenter) {
      const targetCenterX = centerWorldX * scale + offsetX;
      const targetCenterY = centerWorldY * scale + offsetY;
      const maxScrollLeft = Math.max(0, cssWidth - this.body.clientWidth);
      const maxScrollTop = Math.max(0, cssHeight - this.body.clientHeight);
      this.body.scrollLeft = clamp(targetCenterX - (this.body.clientWidth / 2), 0, maxScrollLeft);
      this.body.scrollTop = clamp(targetCenterY - (this.body.clientHeight / 2), 0, maxScrollTop);
    }

    return true;
  }

  // Converts a pointer event to Orbit world coordinates.
  _pointerPosition(event: PointerEvent): { x: number; y: number } {
    const rect = this.canvas.getBoundingClientRect();
    const rawX = event.clientX - rect.left;
    const rawY = event.clientY - rect.top;
    return {
      x: (rawX - this.renderOffsetX) / this.renderScale,
      y: (rawY - this.renderOffsetY) / this.renderScale
    };
  }

  // Hit-tests controls, center handle, and outer ring.
  _hitTest(x: number, y: number): OrbitHit | null {
    const paths = Object.keys(this.state.controls);
    for (const path of paths) {
      const c = this.state.controls[path];
      const d = Math.hypot(c.x - x, c.y - y);
      if (d <= 12) return { mode: 'slider', path };
    }
    const centerDistance = Math.hypot(this.state.center.x - x, this.state.center.y - y);
    if (centerDistance <= this.state.innerRadius + 6) return { mode: 'center' };
    if (Math.abs(centerDistance - this.state.outerRadius) <= 8) return { mode: 'outer' };
    return null;
  }

  // Applies the cursor style corresponding to current interaction mode.
  _updateCursor(mode: OrbitPointerMode | null): void {
    if (mode === 'slider') {
      this.canvas.style.cursor = 'pointer';
      return;
    }
    if (mode === 'center') {
      this.canvas.style.cursor = 'move';
      return;
    }
    if (mode === 'outer') {
      this.canvas.style.cursor = this.pointer ? 'grabbing' : 'grab';
      return;
    }
    this.canvas.style.cursor = 'default';
  }

  // Clamps radii to valid geometric limits.
  _ensureRadii(): void {
    const maxOuter = Math.max(40, Math.min(this.baseWidth, this.baseHeight) * 0.47);
    this.state.outerRadius = clamp(this.state.outerRadius, 30, maxOuter);
    this.state.innerRadius = clamp(this.state.innerRadius, 8, this.state.outerRadius - 6);
    if (!Number.isFinite(this.initialOuterRadius)) {
      this.initialOuterRadius = this.state.outerRadius;
    }
  }

  // Clamps all control coordinates to canvas world bounds.
  _constrainControlPositions(): void {
    for (const control of Object.values(this.state.controls)) {
      control.x = clamp(control.x, 0, this.baseWidth);
      control.y = clamp(control.y, 0, this.baseHeight);
    }
  }

  // Converts a control value to radial distance from center.
  _distanceFromValue(control: OrbitValueRange, value: number | undefined, stateOverride: OrbitState | null = null): number {
    const st = stateOverride || this.state;
    const candidate = value ?? Number.NaN;
    const v = Number.isFinite(candidate) ? candidate : control.min;
    const u = clamp((v - control.min) / (control.max - control.min), 0, 1);
    return st.outerRadius - u * (st.outerRadius - st.innerRadius);
  }

  // Converts a control point position to its corresponding parameter value.
  _valueFromPosition(control: OrbitControl, x: number, y: number): number {
    const d = Math.hypot(x - this.state.center.x, y - this.state.center.y);
    const u = d <= this.state.innerRadius
      ? 1
      : d >= this.state.outerRadius
        ? 0
        : (this.state.outerRadius - d) / (this.state.outerRadius - this.state.innerRadius);

    if (control.type === 'button' || control.type === 'checkbox') {
      const threshold = (this.state.innerRadius + this.state.outerRadius) / 2;
      return d <= threshold ? 1 : 0;
    }

    let value = control.min + u * (control.max - control.min);
    if (control.step > 0) {
      const steps = Math.round((value - control.min) / control.step);
      value = control.min + steps * control.step;
    }
    return clamp(value, control.min, control.max);
  }

  // Checks whether an incoming value matches current control position within tolerance.
  _isValueCompatibleWithCurrentPosition(control: OrbitControl, value: number): boolean {
    const expected = this._valueFromPosition(control, control.x, control.y);
    if (control.type === 'button' || control.type === 'checkbox') {
      return Math.round(value) === Math.round(expected);
    }
    const range = Math.max(1e-9, control.max - control.min);
    const tolerance = control.step > 0 ? (control.step / 2) + 1e-9 : range * 1e-3;
    return Math.abs(value - expected) <= tolerance;
  }

  // Projects a value onto the control radial axis to get world position.
  _positionFromValue(path: Path, value: number): { x: number; y: number } | null {
    const control = this.state.controls[path];
    if (!control) return null;
    const distance = this._distanceFromValue(control, value);
    let dx = control.x - this.state.center.x;
    let dy = control.y - this.state.center.y;
    const mag = Math.hypot(dx, dy);
    if (mag < 1e-6) {
      const idx = Math.max(0, this.controlOrder.indexOf(path));
      const count = Math.max(1, this.controlOrder.length);
      const angle = (idx / count) * Math.PI * 2 - Math.PI / 2;
      dx = Math.cos(angle);
      dy = Math.sin(angle);
    } else {
      dx /= mag;
      dy /= mag;
    }
    return {
      x: clamp(this.state.center.x + dx * distance, 0, this.baseWidth),
      y: clamp(this.state.center.y + dy * distance, 0, this.baseHeight)
    };
  }

  // Emits one control value to the host callback and updates cache.
  _emitValueForControl(control: OrbitControl): void {
    if (!control || !control.enabled) return;
    const value = this._valueFromPosition(control, control.x, control.y);
    this.paramValues[control.path] = value;
    try {
      this.paramChangeByUI(control.path, value);
    } catch {
      // ignore
    }
    if (control.path === this.activePath) this._updateDetailPanel();
  }

  // Emits values for all controls (used when geometry changes globally).
  _emitValuesForAllControls(): void {
    for (const control of Object.values(this.state.controls)) {
      this._emitValueForControl(control);
    }
  }

  // Draws grid, rings, controls, labels, and hover tooltip on canvas.
  _drawNow(): void {
    if (!this.ctx || !this.canvas) return;
    const scale = this.renderScale || 1;
    const offsetX = this.renderOffsetX || 0;
    const offsetY = this.renderOffsetY || 0;
    const canvasCssWidth = Math.max(1, this.canvas.clientWidth || this.baseWidth);
    const canvasCssHeight = Math.max(1, this.canvas.clientHeight || this.baseHeight);
    const minX = -offsetX / scale;
    const minY = -offsetY / scale;
    const drawWidth = canvasCssWidth / scale;
    const drawHeight = canvasCssHeight / scale;
    const maxX = minX + drawWidth;
    const maxY = minY + drawHeight;

    const ctx = this.ctx;
    ctx.clearRect(minX, minY, drawWidth, drawHeight);
    ctx.fillStyle = '#111';
    ctx.fillRect(minX, minY, drawWidth, drawHeight);

    const gridStep = Math.max(8, (this.initialOuterRadius || this.state.outerRadius) / 2);
    const gridOrigin = this.gridOrigin || this.state.center;
    ctx.strokeStyle = 'rgba(255,255,255,0.05)';
    ctx.lineWidth = 1;

    for (let x = gridOrigin.x; x <= maxX; x += gridStep) {
      ctx.beginPath();
      ctx.moveTo(Math.round(x) + 0.5, minY);
      ctx.lineTo(Math.round(x) + 0.5, maxY);
      ctx.stroke();
    }
    for (let x = gridOrigin.x - gridStep; x >= minX; x -= gridStep) {
      ctx.beginPath();
      ctx.moveTo(Math.round(x) + 0.5, minY);
      ctx.lineTo(Math.round(x) + 0.5, maxY);
      ctx.stroke();
    }
    for (let y = gridOrigin.y; y <= maxY; y += gridStep) {
      ctx.beginPath();
      ctx.moveTo(minX, Math.round(y) + 0.5);
      ctx.lineTo(maxX, Math.round(y) + 0.5);
      ctx.stroke();
    }
    for (let y = gridOrigin.y - gridStep; y >= minY; y -= gridStep) {
      ctx.beginPath();
      ctx.moveTo(minX, Math.round(y) + 0.5);
      ctx.lineTo(maxX, Math.round(y) + 0.5);
      ctx.stroke();
    }

    ctx.strokeStyle = 'rgba(255,255,255,0.2)';
    ctx.beginPath();
    ctx.arc(this.state.center.x, this.state.center.y, this.state.outerRadius, 0, Math.PI * 2);
    ctx.stroke();

    ctx.fillStyle = 'rgba(250,250,250,0.15)';
    ctx.beginPath();
    ctx.arc(this.state.center.x, this.state.center.y, this.state.innerRadius, 0, Math.PI * 2);
    ctx.fill();
    ctx.strokeStyle = 'rgba(250,250,250,0.35)';
    ctx.stroke();

    // Subtle crosshair at draggable center.
    const crossHalf = Math.max(4, Math.min(8, this.state.innerRadius * 0.28));
    ctx.strokeStyle = 'rgba(255,255,255,0.32)';
    ctx.lineWidth = 1;
    ctx.beginPath();
    ctx.moveTo(this.state.center.x - crossHalf, this.state.center.y + 0.5);
    ctx.lineTo(this.state.center.x + crossHalf, this.state.center.y + 0.5);
    ctx.moveTo(this.state.center.x + 0.5, this.state.center.y - crossHalf);
    ctx.lineTo(this.state.center.x + 0.5, this.state.center.y + crossHalf);
    ctx.stroke();

    ctx.font = '11px system-ui, sans-serif';
    for (const control of Object.values(this.state.controls)) {
      const iconColor = control.enabled ? control.color : 'rgba(85,85,85,0.5)';
      const labelColor = control.enabled ? 'rgba(255,255,255,0.85)' : 'rgba(105,105,105,0.68)';

      const value = this._valueFromPosition(control, control.x, control.y);
      const normalized = clamp((value - control.min) / (control.max - control.min), 0, 1);
      const ringRadius = 11;
      const ringStart = -Math.PI / 2;
      const ringEnd = ringStart + (Math.PI * 2 * normalized);

      ctx.lineWidth = 2;
      ctx.lineCap = 'round';
      ctx.strokeStyle = control.enabled ? 'rgba(255,255,255,0.2)' : 'rgba(180,180,180,0.12)';
      ctx.beginPath();
      ctx.arc(control.x, control.y, ringRadius, 0, Math.PI * 2);
      ctx.stroke();
      if (normalized > 0.001) {
        ctx.strokeStyle = control.enabled ? 'rgba(255,255,255,0.95)' : 'rgba(200,200,200,0.45)';
        ctx.beginPath();
        ctx.arc(control.x, control.y, ringRadius, ringStart, ringEnd);
        ctx.stroke();
      }

      ctx.fillStyle = iconColor;
      ctx.beginPath();
      ctx.arc(control.x, control.y, 8, 0, Math.PI * 2);
      ctx.fill();
      ctx.strokeStyle = control.enabled ? 'rgba(0,0,0,0.6)' : 'rgba(60,60,60,0.82)';
      ctx.stroke();
      ctx.lineCap = 'butt';
      const label = control.label.length > 16 ? `${control.label.slice(0, 15)}...` : control.label;
      ctx.fillStyle = labelColor;
      ctx.fillText(label, control.x + 10, control.y - 10);
    }

    if (this.hoverHint && !this.pointer) {
      const text = this.hoverHint.text || '';
      if (text) {
        ctx.font = '11px system-ui, sans-serif';
        const padX = 8;
        const padY = 5;
        const textWidth = ctx.measureText(text).width;
        const boxW = Math.ceil(textWidth + padX * 2);
        const boxH = 22;
        const desiredX = this.hoverHint.x + 14;
        const desiredY = this.hoverHint.y - 30;
        const boxX = clamp(desiredX, minX + 4, maxX - boxW - 4);
        const boxY = clamp(desiredY, minY + 4, maxY - boxH - 4);
        ctx.fillStyle = 'rgba(8, 10, 14, 0.9)';
        ctx.strokeStyle = this.hoverHint.accent || 'rgba(255,255,255,0.45)';
        ctx.lineWidth = 1;
        ctx.beginPath();
        ctx.roundRect(boxX, boxY, boxW, boxH, 6);
        ctx.fill();
        ctx.stroke();
        ctx.fillStyle = 'rgba(236, 242, 249, 0.95)';
        ctx.fillText(text, boxX + padX, boxY + boxH - padY - 2);
      }
    }
  }

  // Sets the active control path and refreshes the detail panel.
  _setActivePath(path: Path | null): void {
    if (path === this.activePath) return;
    this.activePath = path;
    this._updateDetailPanel();
  }

  // Navigates to the next/previous control in the ordered control list.
  _navigateControl(direction: 1 | -1): void {
    const paths = this.controlOrder.length > 0
      ? this.controlOrder
      : Object.keys(this.state.controls);
    if (paths.length === 0) return;
    if (!this.activePath || !paths.includes(this.activePath)) {
      this._setActivePath(paths[0]);
      return;
    }
    const idx = paths.indexOf(this.activePath);
    const next = (idx + direction + paths.length) % paths.length;
    this._setActivePath(paths[next]);
  }

  // Increments or decrements the active control value by one step.
  _stepActiveControl(direction: 1 | -1): void {
    if (!this.activePath) return;
    const control = this.state.controls[this.activePath];
    if (!control || !control.enabled) return;
    if (control.type === 'button') return;

    const current = Number.isFinite(this.paramValues[control.path])
      ? this.paramValues[control.path]
      : this._valueFromPosition(control, control.x, control.y);
    const step = control.step > 0 ? control.step : (control.max - control.min) / 100;
    const next = clamp(current + direction * step, control.min, control.max);
    this._applyDetailValue(control, next);
  }

  // Handles Space key for button (press/release) and checkbox (toggle on down).
  _spaceActiveControl(down: boolean): void {
    if (!this.activePath) return;
    const control = this.state.controls[this.activePath];
    if (!control) return;

    if (control.type === 'button') {
      this._applyDetailValue(control, down ? 1 : 0);
      if (down) {
        const b = this.detailEl.querySelector('.orbit-detail-btn') as HTMLElement | null;
        if (b) {
          b.style.borderColor = control.color;
          b.style.background = control.color;
          b.style.color = '#0d1016';
        }
      }
      return;
    }

    if (control.type === 'checkbox') {
      if (down) {
        // Visual feedback on press: highlight border with control color.
        const b = this.detailEl.querySelector('.orbit-detail-btn') as HTMLElement | null;
        if (b) b.style.borderColor = control.color;
      } else {
        // Toggle on release.
        const current = Math.round(
          Number.isFinite(this.paramValues[control.path])
            ? this.paramValues[control.path]
            : this._valueFromPosition(control, control.x, control.y)
        );
        this._applyDetailValue(control, current === 1 ? 0 : 1);
      }
    }
  }

  // Applies a value from the detail panel back to the orbit and host.
  private _applyDetailValue(control: OrbitControl, value: number): void {
    const clamped = clamp(value, control.min, control.max);
    const p = this._positionFromValue(control.path, clamped);
    if (!p) return;
    control.x = p.x;
    control.y = p.y;
    this.paramValues[control.path] = clamped;
    try {
      this.paramChangeByUI(control.path, clamped);
    } catch {
      // ignore
    }
    this._requestRender();
    this._requestStateEmit();
    this._updateDetailPanel();
  }

  // Rebuilds the detail panel DOM for the currently active control.
  _updateDetailPanel(): void {
    if (!this.detailEl) return;

    if (!this.activePath) {
      this.detailEl.innerHTML = '<span class="orbit-detail-empty">Select a control</span>';
      return;
    }

    const control = this.state.controls[this.activePath];
    if (!control) {
      this.detailEl.innerHTML = '<span class="orbit-detail-empty">Select a control</span>';
      this.activePath = null;
      return;
    }

    const value = Number.isFinite(this.paramValues[control.path])
      ? this.paramValues[control.path]
      : this._valueFromPosition(control, control.x, control.y);

    // If an input in the detail panel is being interacted with, update values in place
    // instead of rebuilding the DOM (which would destroy pointer capture on the range thumb).
    const existingValueInput = this.detailEl.querySelector('.orbit-detail-value');
    const existingRangeInput = this.detailEl.querySelector('.orbit-detail-range');
    if (existingValueInput instanceof HTMLInputElement || existingRangeInput instanceof HTMLInputElement) {
      const isFocused = document.activeElement === existingValueInput || document.activeElement === existingRangeInput;
      if (isFocused) {
        if (existingRangeInput instanceof HTMLInputElement) existingRangeInput.value = String(value);
        if (existingValueInput instanceof HTMLInputElement && document.activeElement !== existingValueInput) {
          existingValueInput.value = this._formatValue(value, control.step, control.unit);
        }
        return;
      }
    }

    if (control.type === 'button') {
      this.detailEl.innerHTML = `
        <div class="orbit-detail-label">
          <span class="orbit-detail-color" style="background:${control.color}"></span>
          <span class="orbit-detail-name">${control.label}</span>
        </div>
        <div class="orbit-detail-button-wrap">
          <button type="button" class="orbit-detail-btn">Trigger</button>
        </div>`;
      const btn = this.detailEl.querySelector('.orbit-detail-btn') as HTMLElement | null;
      if (btn) {
        const styleBtn = (el: HTMLElement, active: boolean) => {
          el.style.borderColor = active ? control.color : '';
          el.style.background = active ? control.color : '';
          el.style.color = active ? '#0d1016' : '';
        };
        btn.addEventListener('pointerdown', () => {
          this._applyDetailValue(control, 1);
          // _applyDetailValue rebuilds the DOM, so re-query the new button.
          const b = this.detailEl.querySelector('.orbit-detail-btn') as HTMLElement | null;
          if (b) styleBtn(b, true);
        });
        btn.addEventListener('pointerup', () => {
          this._applyDetailValue(control, 0);
        });
        btn.addEventListener('pointerleave', () => {
          this._applyDetailValue(control, 0);
        });
      }
      return;
    }

    if (control.type === 'checkbox') {
      const checked = Math.round(value) === 1;
      this.detailEl.innerHTML = `
        <div class="orbit-detail-label">
          <span class="orbit-detail-color" style="background:${control.color}"></span>
          <span class="orbit-detail-name">${control.label}</span>
        </div>
        <div class="orbit-detail-button-wrap">
          <button type="button" class="orbit-detail-btn">${control.label}</button>
        </div>`;
      const btn = this.detailEl.querySelector('.orbit-detail-btn') as HTMLElement | null;
      if (btn && checked) {
        btn.style.borderColor = control.color;
        btn.style.background = control.color;
        btn.style.color = '#0d1016';
      }
      if (btn) {
        btn.addEventListener('click', () => {
          this._applyDetailValue(control, checked ? 0 : 1);
        });
      }
      return;
    }

    // Menu-style controls: render a <select> dropdown.
    if (control.menu && control.menu.length > 0 && control.menuStyle !== 'radio') {
      const options = control.menu.map(e =>
        `<option value="${e.value}"${e.value === Math.round(value) ? ' selected' : ''}>${e.label}</option>`
      ).join('');
      this.detailEl.innerHTML = `
        <div class="orbit-detail-label">
          <span class="orbit-detail-color" style="background:${control.color}"></span>
          <span class="orbit-detail-name">${control.label}</span>
        </div>
        <div class="orbit-detail-button-wrap">
          <select class="orbit-detail-select">${options}</select>
        </div>`;
      const sel = this.detailEl.querySelector('.orbit-detail-select');
      if (sel instanceof HTMLSelectElement) {
        sel.addEventListener('change', () => {
          this._applyDetailValue(control, Number(sel.value));
        });
      }
      return;
    }

    // Radio-style controls: render a button group.
    if (control.menu && control.menu.length > 0 && control.menuStyle === 'radio') {
      const rounded = Math.round(value);
      const buttons = control.menu.map(e =>
        `<button type="button" class="orbit-detail-btn orbit-detail-radio" data-value="${e.value}">${e.label}</button>`
      ).join('');
      this.detailEl.innerHTML = `
        <div class="orbit-detail-label">
          <span class="orbit-detail-color" style="background:${control.color}"></span>
          <span class="orbit-detail-name">${control.label}</span>
        </div>
        <div class="orbit-detail-button-wrap">${buttons}</div>`;
      this.detailEl.querySelectorAll('.orbit-detail-radio').forEach(btn => {
        const el = btn as HTMLElement;
        if (Number(el.dataset.value) === rounded) {
          el.style.borderColor = control.color;
          el.style.background = control.color;
          el.style.color = '#0d1016';
        }
        el.addEventListener('click', () => {
          this._applyDetailValue(control, Number(el.dataset.value));
        });
      });
      return;
    }

    // Slider-type controls (hslider, vslider, nentry).
    const displayValue = this._formatValue(value, control.step, control.unit);
    this.detailEl.innerHTML = `
      <div class="orbit-detail-label">
        <span class="orbit-detail-color" style="background:${control.color}"></span>
        <span class="orbit-detail-name">${control.label}</span>
      </div>
      <div class="orbit-detail-slider-wrap">
        <input type="text" class="orbit-detail-value" value="${displayValue}">
        <input type="range" class="orbit-detail-range"
               min="${control.min}" max="${control.max}" step="${control.step || 'any'}"
               value="${value}">
        <span class="orbit-detail-bound">${this._formatValue(control.max, control.step, control.unit)}</span>
      </div>`;

    const rangeInput = this.detailEl.querySelector('.orbit-detail-range');
    const valueInput = this.detailEl.querySelector('.orbit-detail-value');

    if (rangeInput instanceof HTMLInputElement) {
      rangeInput.addEventListener('input', () => {
        const v = Number(rangeInput.value);
        if (!Number.isFinite(v)) return;
        // Update orbit position and host callback without rebuilding the detail DOM,
        // so the range thumb keeps pointer capture during drag.
        const clamped = clamp(v, control.min, control.max);
        const p = this._positionFromValue(control.path, clamped);
        if (!p) return;
        control.x = p.x;
        control.y = p.y;
        this.paramValues[control.path] = clamped;
        try {
          this.paramChangeByUI(control.path, clamped);
        } catch {
          // ignore
        }
        if (valueInput instanceof HTMLInputElement) {
          valueInput.value = this._formatValue(clamped, control.step, control.unit);
        }
        this._requestRender();
        this._requestStateEmit();
      });
    }

    if (valueInput instanceof HTMLInputElement) {
      // On focus, strip the unit to expose only the raw number for editing.
      valueInput.addEventListener('focus', () => {
        const v = parseFloat(valueInput.value);
        if (Number.isFinite(v)) {
          valueInput.value = this._formatValue(v, control.step);
        }
        valueInput.select();
      });

      // On blur, clamp and restore display with unit.
      valueInput.addEventListener('blur', () => {
        const v = parseFloat(valueInput.value);
        if (Number.isFinite(v)) {
          this._applyDetailValue(control, clamp(v, control.min, control.max));
        } else {
          this._updateDetailPanel();
        }
      });

      // Filter input: only allow digits, dot, and minus sign.
      valueInput.addEventListener('keydown', (event: KeyboardEvent) => {
        if (event.key === 'Enter') {
          event.preventDefault();
          valueInput.blur();
          return;
        }
        if (event.key === 'Escape') {
          event.preventDefault();
          this._updateDetailPanel();
          valueInput.blur();
          return;
        }
        if (event.key === 'ArrowUp' || event.key === 'ArrowDown') {
          event.preventDefault();
          event.stopPropagation();
          const step = control.step > 0 ? control.step : (control.max - control.min) / 100;
          const current = parseFloat(valueInput.value);
          if (!Number.isFinite(current)) return;
          const next = clamp(current + (event.key === 'ArrowUp' ? step : -step), control.min, control.max);
          valueInput.value = this._formatValue(next, control.step);
          this._applyDetailValue(control, next);
          return;
        }
        // Allow navigation and editing keys.
        if (event.key === 'Tab' || event.key === 'Backspace' || event.key === 'Delete'
          || event.key === 'ArrowLeft' || event.key === 'ArrowRight'
          || event.key === 'Home' || event.key === 'End'
          || event.ctrlKey || event.metaKey) return;
        // Allow digits, dot, minus.
        if (/^[0-9.\-]$/.test(event.key)) return;
        event.preventDefault();
      });
    }
  }

  // Formats a numeric value for display in the detail panel, with optional unit suffix.
  private _formatValue(value: number, step: number, unit?: string): string {
    const num = (step >= 1 || step <= 0) ? String(Math.round(value)) : value.toFixed(Math.max(0, Math.ceil(-Math.log10(step))));
    return unit ? `${num} ${unit}` : num;
  }

  // Logs non-fatal Orbit warnings without interrupting UI.
  _warn(code: string, details: unknown): void {
    try {
      console.warn(`[FaustOrbitUI] ${code}`, details);
    } catch {
      // ignore
    }
  }
}
