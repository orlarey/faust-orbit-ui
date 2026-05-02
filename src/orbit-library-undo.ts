/**
 * Library undo / redo (niveau-1, scoped per uiHash).
 *
 * The component records one op per user-driven library mutation:
 *   • `add`         — auto-promotion of a new (configHash) entry,
 *   • `rename`      — `name` field changed (prev / next),
 *   • `delete`      — single preset trashed,
 *   • `deleteBatch` — multi-selection trashed.
 *
 * Each op carries a snapshot (full Preset record) sufficient to revert
 * or replay it without referencing live library state. The scope itself
 * is pure stack mechanics: `OrbitUI` owns the live library Map and is
 * the one that mutates it on undo / redo.
 */
import type { Preset } from './orbit-types.js';

export type LibraryOp =
  | { readonly kind: 'add'; readonly record: Preset }
  | {
      readonly kind: 'rename';
      readonly configHash: string;
      readonly prevName: string | undefined;
      readonly nextName: string | undefined;
    }
  | { readonly kind: 'delete'; readonly record: Preset }
  | { readonly kind: 'deleteBatch'; readonly records: ReadonlyArray<Preset> };

export class LibraryUndoScope {
  private past: LibraryOp[] = [];
  private future: LibraryOp[] = [];

  record(op: LibraryOp): void {
    this.past.push(op);
    this.future.length = 0;
  }

  /** Drop both stacks — used after a setter forces external state. */
  clear(): void {
    this.past.length = 0;
    this.future.length = 0;
  }

  canUndo(): boolean { return this.past.length > 0; }
  canRedo(): boolean { return this.future.length > 0; }

  /** Pop the most recent op from past (caller applies its inverse). */
  popUndo(): LibraryOp | null {
    const op = this.past.pop();
    if (op) this.future.push(op);
    return op ?? null;
  }

  /** Pop the most recent op from future (caller re-applies forward). */
  popRedo(): LibraryOp | null {
    const op = this.future.pop();
    if (op) this.past.push(op);
    return op ?? null;
  }
}
