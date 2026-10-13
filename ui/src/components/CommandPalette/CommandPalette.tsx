import { useEffect, useMemo, useRef, useState } from 'react';
import type { CatalogObjectType, ObjectRef } from '../../api/types';
import { openObject, selectTop } from '../../app/actions';
import { COMMANDS } from '../../app/commands';
import { fuzzyMatch, type FuzzyResult } from '../../lib/fuzzy';
import { isTabular, OBJECT_TYPE_SINGULAR } from '../../lib/sql';
import { useCatalog } from '../../store/catalog';
import { useConnections } from '../../store/connections';
import { useUi } from '../../store/ui';
import { ObjectIcon } from '../common/icons';

interface Item {
  key: string;
  label: string;
  detail?: string;
  keys?: string;
  type?: CatalogObjectType;
  match: FuzzyResult;
  run: (alt: boolean) => void;
}

function Hl({ text, positions }: { text: string; positions: number[] }) {
  if (!positions.length) return <>{text}</>;
  const set = new Set(positions);
  return (
    <>
      {[...text].map((ch, i) => (set.has(i) ? <mark key={i}>{ch}</mark> : <span key={i}>{ch}</span>))}
    </>
  );
}

/** Ctrl+Shift+P commands; Ctrl+P (or a leading "@") jumps to any loaded database object across connections. */
export function CommandPalette() {
  const open = useUi((s) => s.paletteOpen);
  const mode = useUi((s) => s.paletteMode);
  const close = useUi((s) => s.closePalette);
  const [q, setQ] = useState('');
  const [sel, setSel] = useState(0);
  const inputRef = useRef<HTMLInputElement>(null);
  const listRef = useRef<HTMLDivElement>(null);
  const dbs = useCatalog((s) => s.dbs);
  const connections = useConnections((s) => s.connections);

  useEffect(() => {
    if (open) {
      setQ(mode === 'objects' ? '@' : '');
      setSel(0);
      inputRef.current?.focus();
    }
  }, [open, mode]);

  const objectMode = q.startsWith('@');
  const pattern = objectMode ? q.slice(1).trim() : q.trim();

  const items = useMemo<Item[]>(() => {
    if (!open) return [];
    if (!objectMode) {
      const out: Item[] = [];
      for (const c of COMMANDS) {
        if (c.enabled && !c.enabled()) continue;
        const label = `${c.category}: ${c.title}`;
        const m = fuzzyMatch(pattern, label);
        if (m) out.push({ key: c.id, label, keys: c.keys, match: m, run: () => c.run() });
      }
      if (pattern) out.sort((a, b) => b.match.score - a.match.score);
      return out.slice(0, 200);
    }
    const names = new Map(connections.map((c) => [c.id, c.name]));
    const out: Item[] = [];
    for (const d of Object.values(dbs)) {
      for (const s of Object.values(d.loaded)) {
        for (const o of s.objects) {
          const m = fuzzyMatch(pattern, o.n);
          if (!m) continue;
          const ref: ObjectRef = { database: d.database, schema: s.name, name: o.n, type: o.t };
          out.push({
            key: `${d.connectionId}|${d.database}|${s.name}|${o.t}|${o.n}`,
            label: o.n,
            detail: `${OBJECT_TYPE_SINGULAR[o.t]} · ${s.name}${d.database && d.database !== s.name ? ` · ${d.database}` : ''} · ${names.get(d.connectionId) ?? ''}`,
            type: o.t,
            match: m,
            run: (alt) => (alt && isTabular(o.t) ? selectTop(d.connectionId, d.database, ref) : openObject(d.connectionId, d.database, ref)),
          });
        }
      }
    }
    out.sort((a, b) => b.match.score - a.match.score || a.label.localeCompare(b.label));
    return out.slice(0, 300);
  }, [open, objectMode, pattern, dbs, connections]);

  useEffect(() => {
    listRef.current?.querySelector('.palette-item.selected')?.scrollIntoView?.({ block: 'nearest' });
  }, [sel]);

  if (!open) return null;
  const choose = (i: number, alt = false) => {
    const it = items[i];
    if (!it) return;
    close();
    it.run(alt);
  };

  return (
    <div className="overlay palette-overlay" onMouseDown={(e) => e.target === e.currentTarget && close()}>
      <div className="palette" role="dialog" aria-label="Command palette">
        <input
          ref={inputRef}
          className="palette-input"
          autoFocus
          value={q}
          placeholder={objectMode ? 'Go to object… (Alt+Enter: select top 1000)' : 'Type a command, or @ to go to an object'}
          aria-label="Command"
          spellCheck={false}
          onChange={(e) => {
            setQ(e.target.value);
            setSel(0);
          }}
          onKeyDown={(e) => {
            if (e.key === 'Escape') { e.preventDefault(); close(); }
            else if (e.key === 'ArrowDown') { e.preventDefault(); setSel((s) => Math.min(items.length - 1, s + 1)); }
            else if (e.key === 'ArrowUp') { e.preventDefault(); setSel((s) => Math.max(0, s - 1)); }
            else if (e.key === 'PageDown') { e.preventDefault(); setSel((s) => Math.min(items.length - 1, s + 10)); }
            else if (e.key === 'PageUp') { e.preventDefault(); setSel((s) => Math.max(0, s - 10)); }
            else if (e.key === 'Enter') { e.preventDefault(); choose(sel, e.altKey); }
          }}
        />
        <div className="palette-list" ref={listRef} role="listbox">
          {items.length === 0 && <div className="palette-empty">{objectMode ? 'No matching objects in loaded schemas' : 'No matching commands'}</div>}
          {items.map((it, i) => (
            <div
              key={it.key}
              role="option"
              aria-selected={i === sel}
              className={`palette-item${i === sel ? ' selected' : ''}`}
              onMouseMove={() => i !== sel && setSel(i)}
              onMouseDown={(e) => {
                e.preventDefault();
                choose(i, e.altKey);
              }}
            >
              {it.type && <ObjectIcon type={it.type} />}
              <span className="palette-label">
                <Hl text={it.label} positions={it.match.positions} />
              </span>
              {it.detail && <span className="palette-detail">{it.detail}</span>}
              {it.keys && <kbd className="palette-keys">{it.keys}</kbd>}
            </div>
          ))}
        </div>
      </div>
    </div>
  );
}
