export type Path = string;
export type ParamValue = number;
export type ParamChangeByUI = (path: Path, value: ParamValue) => void;

/**
 * ============================================================
 * FaustUICore
 * Base transactional UI class for Faust frontends.
 * ============================================================
 */
export class FaustUICore {
  protected readonly root: HTMLElement;
  protected readonly paramChangeByUI: ParamChangeByUI;

  private updateDepth: number;
  private renderPending: boolean;
  private statePending: boolean;
  private destroyed: boolean;

// Base class constructor: binds the host root and parameter callback.
  constructor(root: HTMLElement, paramChangeByUI: ParamChangeByUI) {
    if (!root || !(root instanceof HTMLElement)) {
      throw new Error('FaustUICore: missing root');
    }
    if (typeof paramChangeByUI !== 'function') {
      throw new Error('FaustUICore: missing paramChangeByUI');
    }
    this.root = root;
    this.paramChangeByUI = paramChangeByUI;
    this.updateDepth = 0;
    this.renderPending = false;
    this.statePending = false;
    this.destroyed = false;
  }

  // Opens a batched update block (render/state emissions are deferred).
  beginUpdate(): void {
    if (this.destroyed) return;
    this.updateDepth += 1;
  }

  // Closes a batched update block and flushes deferred work when depth reaches zero.
  endUpdate(): void {
    if (this.destroyed) return;
    if (this.updateDepth > 0) {
      this.updateDepth -= 1;
    }
    if (this.updateDepth === 0) {
      this.flushPending();
    }
  }

  // Runs code inside a begin/end update transaction.
  transaction(fn: () => void): void {
    this.beginUpdate();
    try {
      fn();
    } finally {
      this.endUpdate();
    }
  }

  // Marks this UI instance as destroyed and cancels pending emissions.
  destroy(): void {
    this.destroyed = true;
    this.renderPending = false;
    this.statePending = false;
  }

  // Requests a render now or defers it while inside an update transaction.
  protected requestRender(): void {
    if (this.destroyed) return;
    if (this.updateDepth > 0) {
      this.renderPending = true;
      return;
    }
    if (typeof this.flushRender === 'function') {
      this.flushRender();
      return;
    }
    const legacy = this as unknown as { _flushRender?: () => void };
    if (typeof legacy._flushRender === 'function') {
      legacy._flushRender();
    }
  }

  // Requests a state emission now or defers it while inside an update transaction.
  protected requestStateEmit(): void {
    if (this.destroyed) return;
    if (this.updateDepth > 0) {
      this.statePending = true;
      return;
    }
    if (typeof this.emitState === 'function') {
      this.emitState();
      return;
    }
    const legacy = this as unknown as { _emitState?: () => void };
    if (typeof legacy._emitState === 'function') {
      legacy._emitState();
    }
  }

  protected flushRender?(): void;

  protected emitState?(): void;

  // Legacy alias used by existing subclasses.
  protected _requestRender(): void {
    this.requestRender();
  }

  // Legacy alias used by existing subclasses.
  protected _requestStateEmit(): void {
    this.requestStateEmit();
  }

  // Flushes deferred render/state work accumulated during transactions.
  private flushPending(): void {
    if (this.destroyed) return;
    const doRender = this.renderPending;
    const doState = this.statePending;
    this.renderPending = false;
    this.statePending = false;
    if (doRender) {
      if (typeof this.flushRender === 'function') {
        this.flushRender();
      } else {
        const legacy = this as unknown as { _flushRender?: () => void };
        if (typeof legacy._flushRender === 'function') legacy._flushRender();
      }
    }
    if (doState) {
      if (typeof this.emitState === 'function') {
        this.emitState();
      } else {
        const legacy = this as unknown as { _emitState?: () => void };
        if (typeof legacy._emitState === 'function') legacy._emitState();
      }
    }
  }

  // Legacy alias used by existing subclasses.
  protected _flushPending(): void {
    this.flushPending();
  }
}
