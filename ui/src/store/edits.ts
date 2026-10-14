// Pending data edits per grid (PLAN-M1.5 A1). One buffer per grid key (result set view key or data tab id).
// Pending changes are an immutable object; undo/redo keep previous snapshots, so every operation is undoable.
import { create } from 'zustand';
import type { CellValue } from '../api/types';

export interface PendingInsert {
  id: string;
  /** Full row in result column order; untouched cells stay null and are left out of the INSERT. */
  values: CellValue[];
  touched: Record<number, true>;
}

export interface Pending {
  /** source row → column → new value */
  updates: Record<number, Record<number, CellValue>>;
  inserts: PendingInsert[];
  deletes: Record<number, true>;
}

/** What earlier submits changed: refetched rows, deleted rows and inserted rows (shown after the base rows). */
export interface Committed {
  patched: Record<number, CellValue[]>;
  hidden: Record<number, true>;
  appended: CellValue[][];
}

export interface RowIssue {
  /** Source row index as string, or an insert id. */
  ref: string;
  kind: 'conflict' | 'error';
  message: string;
}

export interface EditBuffer {
  pending: Pending;
  committed: Committed;
  undo: Pending[];
  redo: Pending[];
  status: 'idle' | 'submitting';
  error: string | null;
  issues: RowIssue[];
}

export const EMPTY_PENDING: Pending = { updates: {}, inserts: [], deletes: {} };
const EMPTY_COMMITTED: Committed = { patched: {}, hidden: {}, appended: [] };
const UNDO_LIMIT = 200;

export function emptyBuffer(): EditBuffer {
  return { pending: EMPTY_PENDING, committed: EMPTY_COMMITTED, undo: [], redo: [], status: 'idle', error: null, issues: [] };
}

export function pendingCount(p: Pending): number {
  return Object.keys(p.updates).length + p.inserts.length + Object.keys(p.deletes).length;
}

export function hasPending(b: EditBuffer | undefined): boolean {
  return !!b && pendingCount(b.pending) > 0;
}

/** Value a cell currently shows: pending edit if any, else the committed/base value. */
export function editedValue(p: Pending, row: number, col: number): CellValue | undefined {
  const r = p.updates[row];
  return r && col in r ? r[col] : undefined;
}

let insertSeq = 0;

interface EditsState {
  buffers: Record<string, EditBuffer>;
  /** Grid that last had focus (target of keyboard commands). */
  activeGrid: string | null;
  get(key: string): EditBuffer;
  setActiveGrid(key: string | null): void;
  /** Set a cell; `original` is the committed value (an edit back to it removes the pending edit). */
  setCell(key: string, row: number, col: number, value: CellValue, original: CellValue): void;
  setInsertCell(key: string, id: string, col: number, value: CellValue): void;
  addInsert(key: string, columnCount: number, defaults?: Record<number, CellValue>): string;
  removeInsert(key: string, id: string): void;
  toggleDelete(key: string, rows: number[], on?: boolean): void;
  revertRow(key: string, row: number): void;
  revertAll(key: string): void;
  undo(key: string): void;
  redo(key: string): void;
  setStatus(key: string, status: EditBuffer['status'], error?: string | null, issues?: RowIssue[]): void;
  /** After a successful submit: clear pending and fold the refetched rows into `committed`. */
  commit(key: string, result: { patched?: Record<number, CellValue[]>; hidden?: number[]; appended?: CellValue[][]; keepInserts?: string[] }): void;
  /** Drop a buffer (grid closed, rows reloaded). */
  reset(key: string): void;
}

export const useEdits = create<EditsState>((set, get) => {
  const write = (key: string, fn: (b: EditBuffer) => EditBuffer) => {
    const cur = get().buffers[key] ?? emptyBuffer();
    const next = fn(cur);
    if (next !== cur) set({ buffers: { ...get().buffers, [key]: next } });
  };
  /** Apply a change to pending with an undo snapshot. */
  const change = (key: string, fn: (p: Pending) => Pending) =>
    write(key, (b) => {
      const p = fn(b.pending);
      if (p === b.pending) return b;
      return { ...b, pending: p, undo: [...b.undo.slice(-UNDO_LIMIT + 1), b.pending], redo: [], error: null, issues: [] };
    });

  return {
    buffers: {},
    activeGrid: null,

    get(key) {
      return get().buffers[key] ?? emptyBuffer();
    },

    setActiveGrid(key) {
      if (get().activeGrid !== key) set({ activeGrid: key });
    },

    setCell(key, row, col, value, original) {
      change(key, (p) => {
        const cur = p.updates[row];
        const had = !!cur && col in cur;
        const revert = sameValue(value, original);
        if (revert ? !had : had && sameValue(cur![col], value)) return p;
        const rowEdits = { ...(cur ?? {}) };
        if (revert) delete rowEdits[col];
        else rowEdits[col] = value;
        const updates = { ...p.updates };
        if (Object.keys(rowEdits).length) updates[row] = rowEdits;
        else delete updates[row];
        return { ...p, updates };
      });
    },

    setInsertCell(key, id, col, value) {
      change(key, (p) => ({
        ...p,
        inserts: p.inserts.map((r) => (r.id === id ? { ...r, values: r.values.map((v, i) => (i === col ? value : v)), touched: { ...r.touched, [col]: true } } : r)),
      }));
    },

    addInsert(key, columnCount, defaults = {}) {
      const id = `new${++insertSeq}`;
      change(key, (p) => ({
        ...p,
        inserts: [...p.inserts, { id, values: Array.from({ length: columnCount }, (_, i) => (i in defaults ? defaults[i] : null)), touched: {} }],
      }));
      return id;
    },

    removeInsert(key, id) {
      change(key, (p) => ({ ...p, inserts: p.inserts.filter((r) => r.id !== id) }));
    },

    toggleDelete(key, rows, on) {
      if (!rows.length) return;
      change(key, (p) => {
        const deletes = { ...p.deletes };
        const allOn = rows.every((r) => deletes[r]);
        const target = on ?? !allOn;
        for (const r of rows) {
          if (target) deletes[r] = true;
          else delete deletes[r];
        }
        return { ...p, deletes };
      });
    },

    revertRow(key, row) {
      change(key, (p) => {
        if (!p.updates[row] && !p.deletes[row]) return p;
        const updates = { ...p.updates };
        const deletes = { ...p.deletes };
        delete updates[row];
        delete deletes[row];
        return { ...p, updates, deletes };
      });
    },

    revertAll(key) {
      change(key, (p) => (pendingCount(p) ? EMPTY_PENDING : p));
    },

    undo(key) {
      write(key, (b) => {
        if (!b.undo.length) return b;
        const prev = b.undo[b.undo.length - 1];
        return { ...b, pending: prev, undo: b.undo.slice(0, -1), redo: [...b.redo, b.pending], issues: [] };
      });
    },

    redo(key) {
      write(key, (b) => {
        if (!b.redo.length) return b;
        const next = b.redo[b.redo.length - 1];
        return { ...b, pending: next, redo: b.redo.slice(0, -1), undo: [...b.undo, b.pending], issues: [] };
      });
    },

    setStatus(key, status, error = null, issues = []) {
      write(key, (b) => ({ ...b, status, error, issues }));
    },

    commit(key, r) {
      write(key, (b) => {
        const hidden = { ...b.committed.hidden };
        for (const h of r.hidden ?? []) hidden[h] = true;
        const keep = new Set(r.keepInserts ?? []);
        return {
          ...b,
          pending: keep.size ? { ...EMPTY_PENDING, inserts: b.pending.inserts.filter((i) => keep.has(i.id)) } : EMPTY_PENDING,
          committed: {
            patched: { ...b.committed.patched, ...r.patched },
            hidden,
            appended: [...b.committed.appended, ...(r.appended ?? [])],
          },
          undo: [],
          redo: [],
          status: 'idle',
          error: null,
          issues: [],
        };
      });
    },

    reset(key) {
      if (!get().buffers[key]) return;
      const buffers = { ...get().buffers };
      delete buffers[key];
      set({ buffers, activeGrid: get().activeGrid === key ? null : get().activeGrid });
    },
  };
});

export function sameValue(a: CellValue | undefined, b: CellValue | undefined): boolean {
  if (a === b) return true;
  if (a === undefined || b === undefined || a === null || b === null) return false;
  if (typeof a === 'object' || typeof b === 'object') return JSON.stringify(a) === JSON.stringify(b);
  if (typeof a === 'number' || typeof b === 'number') return String(a) === String(b);
  return false;
}

export function useEditBuffer(key: string): EditBuffer {
  return useEdits((s) => s.buffers[key]) ?? EMPTY_BUFFER;
}

const EMPTY_BUFFER = emptyBuffer();
