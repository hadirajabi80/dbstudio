// Pending-edit buffers: batch cell edits (design-r2-04) and rows saved into an open transaction (features-r2-01).
import { beforeEach, describe, expect, it } from 'vitest';
import { pendingCount, useEdits } from './edits';

const s = () => useEdits.getState();

describe('edit buffers', () => {
  beforeEach(() => useEdits.setState({ buffers: {}, activeGrid: null }));

  describe('setCells: one undoable change (Set selected cells to NULL)', () => {
    it('sets source-row cells and insert cells together; one Undo reverts all of them', () => {
      const id = s().addInsert('g', 3);
      s().setCells('g', [
        { row: 0, col: 1, value: null, original: 'Ada' },
        { row: 1, col: 1, value: null, original: 'Grace' },
        { insertId: id, col: 2, value: null },
      ]);
      const b = s().get('g');
      expect(b.pending.updates).toEqual({ 0: { 1: null }, 1: { 1: null } });
      expect(b.pending.inserts[0].touched).toEqual({ 2: true });
      expect(b.undo).toHaveLength(2); // addInsert + the batch
      s().undo('g');
      expect(s().get('g').pending.updates).toEqual({});
      expect(s().get('g').pending.inserts[0].touched).toEqual({});
    });

    it('cells that already hold NULL change nothing and add no undo step', () => {
      s().setCells('g', [{ row: 0, col: 1, value: null, original: null }]);
      expect(pendingCount(s().get('g').pending)).toBe(0);
      expect(s().get('g').undo).toHaveLength(0);
      s().setCells('g', []);
      expect(s().buffers.g).toBeUndefined();
    });
  });

  describe('rows saved into an open transaction (features-r2-01)', () => {
    it('noteSavedInTx adds up per session; another session replaces the note', () => {
      expect(s().get('g').savedInTx).toBeNull();
      s().noteSavedInTx('g', 'S1', 2);
      s().noteSavedInTx('g', 'S1', 1);
      expect(s().get('g').savedInTx).toEqual({ sessionId: 'S1', rows: 3 });
      s().noteSavedInTx('g', 'S2', 1);
      expect(s().get('g').savedInTx).toEqual({ sessionId: 'S2', rows: 1 });
      s().noteSavedInTx('g', 'S2', 0);
      expect(s().get('g').savedInTx).toEqual({ sessionId: 'S2', rows: 1 });
    });

    it('a rollback marks every grid of that session and only those', () => {
      s().noteSavedInTx('a', 'S1', 2);
      s().noteSavedInTx('b', 'S1', 1);
      s().noteSavedInTx('c', 'S2', 4);
      s().setCell('d', 0, 1, 'x', 'y');
      const untouched = s().buffers.d;
      s().applyTxEnd({ sessionId: 'S1', kind: 'rollback' });
      expect(s().get('a')).toMatchObject({ savedInTx: null, rolledBack: { rows: 2 } });
      expect(s().get('b')).toMatchObject({ savedInTx: null, rolledBack: { rows: 1 } });
      expect(s().get('c')).toMatchObject({ savedInTx: { sessionId: 'S2', rows: 4 }, rolledBack: null });
      expect(s().buffers.d).toBe(untouched);
      // Applied twice (several result panes listen): nothing more happens.
      s().applyTxEnd({ sessionId: 'S1', kind: 'rollback' });
      expect(s().get('a').rolledBack).toEqual({ rows: 2 });
    });

    it('a commit forgets the saved rows without a notice; a later rollback does not flag them', () => {
      s().noteSavedInTx('a', 'S1', 2);
      s().applyTxEnd({ sessionId: 'S1', kind: 'commit' });
      expect(s().get('a')).toMatchObject({ savedInTx: null, rolledBack: null });
      s().applyTxEnd({ sessionId: 'S1', kind: 'rollback' });
      expect(s().get('a').rolledBack).toBeNull();
    });

    it('the note survives the save bookkeeping; dismiss and reset clear the notice', () => {
      s().setCell('a', 0, 1, 'x', 'y');
      s().noteSavedInTx('a', 'S1', 1);
      s().commit('a', { patched: { 0: [1, 'x'] } });
      s().setStatus('a', 'idle');
      expect(s().get('a').savedInTx).toEqual({ sessionId: 'S1', rows: 1 });
      s().applyTxEnd({ sessionId: 'S1', kind: 'rollback' });
      s().dismissRolledBack('a');
      expect(s().get('a').rolledBack).toBeNull();
      s().noteSavedInTx('a', 'S1', 1);
      s().applyTxEnd({ sessionId: 'S1', kind: 'rollback' });
      s().reset('a');
      expect(s().get('a').rolledBack).toBeNull();
    });
  });
});
