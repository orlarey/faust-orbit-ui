/**
 * Param undo / redo (niveau-2, per ORBITDATAMODELSPEC §I.2).
 *
 * One scope per OrbitUI instance. Each operation records the audible
 * parameter configuration before AND after a gesture; undo applies
 * `before`, redo applies `after`. Setters that push state from outside
 * (`setParams`) clear both stacks per ORBITUIAPISPEC convention.
 *
 * No-op gestures (where `before` and `after` are equal) are NOT recorded
 * so a press-without-drag doesn't pollute the stack.
 */

export type ParamOp = {
  readonly before: Readonly<Record<string, number>>;
  readonly after: Readonly<Record<string, number>>;
};

export class ParamUndoScope {
  private past: ParamOp[] = [];
  private future: ParamOp[] = [];

  /** Record a gesture's before/after pair. Skipped silently if the two
   *  configurations are equal (within tolerance). */
  record(op: ParamOp): void {
    if (configsEqual(op.before, op.after)) return;
    this.past.push(op);
    this.future.length = 0;
  }

  /** Drop both stacks — used after `setParams` forces external state. */
  clear(): void {
    this.past.length = 0;
    this.future.length = 0;
  }

  canUndo(): boolean { return this.past.length > 0; }
  canRedo(): boolean { return this.future.length > 0; }

  popUndo(): ParamOp | null {
    const op = this.past.pop();
    if (op) this.future.push(op);
    return op ?? null;
  }

  popRedo(): ParamOp | null {
    const op = this.future.pop();
    if (op) this.past.push(op);
    return op ?? null;
  }
}

function configsEqual(
  a: Readonly<Record<string, number>>,
  b: Readonly<Record<string, number>>,
): boolean {
  const keys = new Set([...Object.keys(a), ...Object.keys(b)]);
  for (const k of keys) {
    const va = a[k] ?? 0;
    const vb = b[k] ?? 0;
    if (Math.abs(va - vb) > 1e-9) return false;
  }
  return true;
}
