import { Keyboard, Search, TriangleAlert } from 'lucide-react';
import { useMemo, useState } from 'react';
import { findConflicts, listBindings, getCommand, type ShortcutBinding } from '../../commands/registry';
import { useCommandsVersion } from '../../commands/useCommands';
import { displayShortcut } from '../../commands/keys';
import { useUi } from '../../store/ui';
import { Dialog } from '../common/Dialog';
import { Kbd } from './Kbd';

const SCOPE_LABEL: Record<string, string> = {
  global: '', editor: 'in the editor', grid: 'in a result grid', explorer: 'in the explorer', history: 'in history',
  designer: 'in a designer', dataTab: 'in a data tab', results: 'in results',
};

interface Row {
  id: string;
  title: string;
  category: string;
  scope: string;
  bindings: ShortcutBinding[];
}

/** Ctrl+K Ctrl+S / F1: searchable list of every registered shortcut, grouped by category. */
export function ShortcutSheet() {
  const open = useUi((s) => s.shortcutsOpen);
  if (!open) return null;
  return <Sheet />;
}

function Sheet() {
  const close = () => useUi.getState().setShortcutsOpen(false);
  const [q, setQ] = useState('');
  const version = useCommandsVersion();
  const { rows, conflicts } = useMemo(() => {
    const byCmd = new Map<string, Row>();
    for (const b of listBindings()) {
      const c = getCommand(b.commandId);
      if (!c) continue;
      let r = byCmd.get(c.id);
      if (!r) byCmd.set(c.id, (r = { id: c.id, title: c.title, category: c.category, scope: c.scope ?? 'global', bindings: [] }));
      r.bindings.push(b);
    }
    return { rows: [...byCmd.values()], conflicts: findConflicts() };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [version]);

  const needle = q.trim().toLowerCase();
  const filtered = rows.filter((r) => {
    if (!needle) return true;
    const keys = r.bindings.map((b) => `${b.display} ${displayShortcut(b.key)}`).join(' ').toLowerCase();
    return `${r.category} ${r.title} ${r.id} ${keys}`.toLowerCase().includes(needle);
  });
  const groups = new Map<string, Row[]>();
  for (const r of filtered.sort((a, b) => a.category.localeCompare(b.category) || a.title.localeCompare(b.title))) {
    if (!groups.has(r.category)) groups.set(r.category, []);
    groups.get(r.category)!.push(r);
  }

  return (
    <Dialog
      title={
        <span className="dialog-title-icon">
          <Keyboard size={16} /> Keyboard shortcuts
        </span>
      }
      ariaLabel="Keyboard shortcuts"
      onClose={close}
      width={720}
      className="shortcut-sheet"
    >
      <div className="search-box sheet-search">
        <Search size={14} />
        <input
          className="input borderless"
          placeholder={`Search by command or key (e.g. “format” or “${displayShortcut('Mod+Shift')}”)`}
          aria-label="Search shortcuts"
          value={q}
          data-autofocus
          onChange={(e) => setQ(e.target.value)}
        />
      </div>
      {conflicts.length > 0 && (
        <div className="sheet-conflicts" role="alert">
          <TriangleAlert size={14} />
          {conflicts.length} shortcut conflict(s): {conflicts.map((c) => `${displayShortcut(c.key)} → ${c.commands.join(', ')}`).join('; ')}
        </div>
      )}
      <div className="sheet-body">
        {groups.size === 0 && <div className="sheet-empty">No shortcut matches “{q}”.</div>}
        {[...groups.entries()].map(([cat, list]) => (
          <section key={cat} className="sheet-group">
            <h3>{cat}</h3>
            <dl>
              {list.map((r) => (
                <div key={r.id} className="sheet-row">
                  <dt>
                    {r.title}
                    {SCOPE_LABEL[r.scope] ? <span className="sheet-scope">{SCOPE_LABEL[r.scope]}</span> : r.scope !== 'global' ? <span className="sheet-scope">in {r.scope}</span> : null}
                  </dt>
                  <dd>
                    {r.bindings.map((b, i) => (
                      <span key={b.key} className="sheet-binding">
                        {i > 0 && <span className="sheet-or">or</span>}
                        <Kbd shortcut={b.key} />
                      </span>
                    ))}
                  </dd>
                </div>
              ))}
            </dl>
          </section>
        ))}
      </div>
    </Dialog>
  );
}
