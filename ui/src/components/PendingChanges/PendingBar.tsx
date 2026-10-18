// Discard / Save (n) ▾ of a result-set or Data-tab toolbar while a grid has pending edits (user-02). Save writes the
// changes directly (no SQL dialog, like Navicat); the caret menu offers "Preview SQL…" and "Copy SQL". Every entry is
// a registered command, so menus, the palette and shortcuts stay in sync.
import { Check, ChevronDown, LoaderCircle, Undo2 } from 'lucide-react';
import { ariaKeyShortcuts } from '../../commands/keys';
import { commandView } from '../../commands/useCommands';
import { useEditBuffer } from '../../store/edits';
import { showMenuBelow } from '../common/Menu';
import { gridController } from '../Grid/controller';
import { commandMenuItems } from '../layout/commandMenu';
import { GRID_SAVE_MENU } from '../ResultsPane/toolbarModel';
import type { PendingChangesActions } from './usePendingChanges';
import './pendingchanges.css';

export function PendingBar({ gridKey, count, actions }: { gridKey: string; count: number; actions: PendingChangesActions }) {
  const buffer = useEditBuffer(gridKey);
  const busy = buffer.status === 'submitting';
  const args = { gridKey };
  const save = commandView('grid.submitChanges', args);
  const discard = commandView('grid.revertAll', args);
  // Through the grid, so a value still being typed in the cell editor is part of the save (design-01).
  const doSave = () => {
    const g = gridController(gridKey);
    if (g?.submit) g.submit();
    else actions.save();
  };
  return (
    <>
      <button className="btn btn-xs" disabled={busy} onClick={() => actions.discard()} title={discard.tooltip}>
        <Undo2 size={12} /> Discard
      </button>
      <span className="split-btn pending-save">
        <button className="btn btn-xs btn-primary" disabled={busy} onClick={doSave} title={save.tooltip} aria-keyshortcuts={ariaKeyShortcuts(save.shortcut)}>
          {busy ? <LoaderCircle size={12} className="spin" /> : <Check size={12} strokeWidth={2.5} />} {busy ? 'Saving…' : `Save (${count})`}
        </button>
        <button
          className="btn btn-xs btn-primary split-caret"
          disabled={busy}
          aria-haspopup="menu"
          aria-label="More save options"
          title="Preview or copy the SQL of the pending changes"
          onClick={(e) => showMenuBelow(e.currentTarget, commandMenuItems(GRID_SAVE_MENU, args))}
        >
          <ChevronDown size={12} />
        </button>
      </span>
    </>
  );
}
