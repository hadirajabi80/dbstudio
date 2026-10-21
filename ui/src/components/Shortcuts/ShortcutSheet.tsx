import { CircleDot, Keyboard, Search, TriangleAlert } from 'lucide-react';
import { useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import { findConflicts, listBindings, getCommand, type ShortcutBinding } from '../../commands/registry';
import { useCommandsVersion } from '../../commands/useCommands';
import { displayShortcut, isMac, shortcutKeys } from '../../commands/keys';
import { inTextField, pushKeyCapture } from '../../commands/dispatcher';
import { useUi } from '../../store/ui';
import { Dialog } from '../common/Dialog';
import { Kbd } from './Kbd';
import {
  bindingsWithModifiers, classifyKeyDown, eventModifiers, hintAnnouncement, HINT_DELAY_MS, searchStroke, spokenShortcut,
} from './keySearch';
import './shortcuts.css';

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

/** A pressed combination and the bindings it found (kept after the keys are released). */
interface Found {
  key: string;
  bindings: ShortcutBinding[];
}

const bindingId = (b: Pick<ShortcutBinding, 'commandId' | 'key'>) => `${b.commandId}|${b.key}`;

/**
 * Ctrl+K Ctrl+S / F1: searchable list of every registered shortcut, grouped by category.
 *
 * Key search: holding modifiers dims every shortcut that does not start with exactly that set (dimming, not
 * filtering, so the list never reflows under the pointer while Shift or Ctrl is tapped); pressing a combination
 * selects and scrolls to its commands without running them; a chord's first stroke waits for the second.
 */
export function ShortcutSheet() {
  const open = useUi((s) => s.shortcutsOpen);
  if (!open) return null;
  return <Sheet />;
}

function Sheet() {
  const close = () => useUi.getState().setShortcutsOpen(false);
  const [q, setQ] = useState('');
  const version = useCommandsVersion();
  const { rows, conflicts, bindings } = useMemo(() => {
    const byCmd = new Map<string, Row>();
    const all: ShortcutBinding[] = [];
    for (const b of listBindings()) {
      const c = getCommand(b.commandId);
      if (!c) continue;
      let r = byCmd.get(c.id);
      if (!r) byCmd.set(c.id, (r = { id: c.id, title: c.title, category: c.category, scope: c.scope ?? 'global', bindings: [] }));
      r.bindings.push(b);
      all.push(b);
    }
    return { rows: [...byCmd.values()], conflicts: findConflicts(), bindings: all };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [version]);

  const [held, setHeld] = useState('');
  const [pending, setPending] = useState<string | null>(null);
  const [found, setFound] = useState<Found | null>(null);
  const [recording, setRecording] = useState(false);
  const [announce, setAnnounce] = useState('');
  const altGraph = useRef(false);
  const heldNow = useRef('');
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const bodyRef = useRef<HTMLDivElement>(null);
  const state = useRef({ pending, recording, bindings });
  state.current = { pending, recording, bindings };

  const needle = q.trim().toLowerCase();
  const filtered = rows.filter((r) => {
    if (!needle) return true;
    const keys = r.bindings.map((b) => `${b.display} ${displayShortcut(b.key)}`).join(' ').toLowerCase();
    return `${r.category} ${r.title} ${r.id} ${keys}`.toLowerCase().includes(needle);
  });
  const visible = useRef(filtered);
  visible.current = filtered;

  /** Follows the held modifier set: at once when released, after a short delay when pressed (AltGr, Shift+letter). */
  const holdModifiers = useCallback((mods: string) => {
    if (mods === heldNow.current) return;
    const before = heldNow.current.split('+');
    const grew = mods.split('+').some((m) => m && !before.includes(m));
    heldNow.current = mods;
    if (timer.current) clearTimeout(timer.current);
    timer.current = null;
    // a new modifier starts a new question: drop the previous combination's selection
    if (grew) setFound(null);
    if (!mods) {
      setHeld('');
      return;
    }
    timer.current = setTimeout(() => {
      timer.current = null;
      setHeld(mods);
      const n = bindingsWithModifiers(visible.current.flatMap((r) => r.bindings), mods).length;
      setAnnounce(hintAnnouncement(n, mods));
    }, HINT_DELAY_MS);
  }, []);

  const findStroke = useCallback((stroke: string) => {
    const { bindings: all, pending: prefix } = state.current;
    const res = searchStroke(all, stroke, prefix);
    const names = (list: ShortcutBinding[]) => [...new Set(list.map((b) => getCommand(b.commandId)?.title ?? b.commandId))].join(', ');
    if (res.chords.length) {
      setPending(res.key);
      setFound(res.exact.length ? { key: res.key, bindings: res.exact } : null);
      const n = res.chords.length;
      setAnnounce(`${spokenShortcut(res.key)}: ${n} chord${n === 1 ? '' : 's'}, press the second key`);
      return;
    }
    setPending(null);
    setFound({ key: res.key, bindings: res.exact });
    setAnnounce(res.exact.length ? `${spokenShortcut(res.key)}: ${names(res.exact)}` : `No shortcut uses ${spokenShortcut(res.key)}`);
    // a match hidden by the text filter: show the whole list again
    const shown = new Set(visible.current.flatMap((r) => r.bindings.map(bindingId)));
    if (res.exact.length && !res.exact.some((b) => shown.has(bindingId(b)))) setQ('');
  }, []);

  useEffect(() => {
    const onKeyDown = (e: KeyboardEvent): boolean => {
      const { recording: rec, pending: prefix } = state.current;
      if (e.key === 'AltGraph') altGraph.current = true;
      if (e.key === 'Escape' && (rec || prefix)) {
        // Escape first ends recording / a half-typed chord; the next one closes the sheet
        e.preventDefault();
        e.stopPropagation();
        if (prefix) setPending(null);
        else setRecording(false);
        setAnnounce(prefix ? 'Chord cancelled' : 'Stopped recording keys');
        return true;
      }
      const intent = classifyKeyDown(e, {
        textField: inTextField(e.target), recording: rec, chordPending: !!prefix, altGraph: altGraph.current,
      });
      if (intent.kind === 'modifiers') {
        holdModifiers(intent.mods);
        return false;
      }
      if (intent.kind === 'pass') return false;
      // Look the keys up, never run them: no command, no native menu accelerator, no browser default (F5, Ctrl+P…).
      e.preventDefault();
      e.stopPropagation();
      findStroke(intent.stroke);
      return true;
    };
    const onKeyUp = (e: KeyboardEvent) => {
      if (e.key === 'AltGraph') altGraph.current = false;
      holdModifiers(altGraph.current ? '' : eventModifiers(e));
    };
    const reset = () => {
      altGraph.current = false;
      holdModifiers('');
    };
    const off = pushKeyCapture(onKeyDown);
    window.addEventListener('keyup', onKeyUp, true);
    window.addEventListener('blur', reset);
    return () => {
      off();
      window.removeEventListener('keyup', onKeyUp, true);
      window.removeEventListener('blur', reset);
      if (timer.current) clearTimeout(timer.current);
    };
  }, [holdModifiers, findStroke]);

  // Bring the first found command into view (instantly when the user asked for reduced motion).
  useEffect(() => {
    if (!found?.bindings.length) return;
    const el = bodyRef.current?.querySelector('.sheet-row.is-selected');
    const reduce = window.matchMedia?.('(prefers-reduced-motion: reduce)').matches;
    el?.scrollIntoView?.({ block: 'nearest', behavior: reduce ? 'auto' : 'smooth' });
  }, [found]);

  const hinted = useMemo(() => {
    if (pending) return new Set(bindings.filter((b) => b.key.startsWith(`${pending} `)).map(bindingId));
    if (held) return new Set(bindingsWithModifiers(bindings, held).map(bindingId));
    return null;
  }, [bindings, held, pending]);
  const selected = useMemo(() => new Set(found?.bindings.map(bindingId) ?? []), [found]);

  const groups = new Map<string, Row[]>();
  for (const r of filtered.sort((a, b) => a.category.localeCompare(b.category) || a.title.localeCompare(b.title))) {
    if (!groups.has(r.category)) groups.set(r.category, []);
    groups.get(r.category)!.push(r);
  }
  const hintCount = hinted ? filtered.reduce((n, r) => n + r.bindings.filter((b) => hinted.has(bindingId(b))).length, 0) : 0;

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
          placeholder={recording ? 'Press a key combination to find it (Esc to stop)' : `Search by command or key (e.g. “format” or “${displayShortcut('Mod+Shift')}”)`}
          aria-label="Search shortcuts"
          value={q}
          data-autofocus
          onChange={(e) => {
            setQ(e.target.value);
            setFound(null);
          }}
        />
        <button
          type="button"
          className={`search-toggle${recording ? ' on' : ''}`}
          aria-pressed={recording}
          aria-label="Record keys"
          title={recording ? 'Recording keys: every key press is looked up (Esc to stop)' : 'Record keys: look up any key press, plain keys too'}
          onClick={() => {
            setRecording((r) => !r);
            setPending(null);
            setFound(null);
          }}
        >
          <CircleDot size={14} />
        </button>
      </div>
      <KeysBar held={held} pending={pending} found={found} recording={recording} hintCount={hintCount} />
      <div className="sr-only" role="status" aria-live="polite" aria-atomic="true">
        {announce}
      </div>
      {conflicts.length > 0 && (
        <div className="sheet-conflicts" role="alert">
          <TriangleAlert size={14} />
          {conflicts.length} shortcut conflict(s): {conflicts.map((c) => `${displayShortcut(c.key)} → ${c.commands.join(', ')}`).join('; ')}
        </div>
      )}
      <div ref={bodyRef} className={`sheet-body${hinted ? ' is-hinting' : ''}`} tabIndex={-1}>
        {groups.size === 0 && <div className="sheet-empty">No shortcut matches “{q}”.</div>}
        {[...groups.entries()].map(([cat, list]) => (
          <section key={cat} className="sheet-group">
            <h3>{cat}</h3>
            <dl>
              {list.map((r) => {
                const isSel = r.bindings.some((b) => selected.has(bindingId(b)));
                const isHint = !!hinted && r.bindings.some((b) => hinted.has(bindingId(b)));
                return (
                  <div key={r.id} className={`sheet-row${isSel ? ' is-selected' : ''}${isHint ? ' is-hint' : ''}`} data-command={r.id}>
                    <dt>
                      {r.title}
                      {SCOPE_LABEL[r.scope] ? <span className="sheet-scope">{SCOPE_LABEL[r.scope]}</span> : r.scope !== 'global' ? <span className="sheet-scope">in {r.scope}</span> : null}
                    </dt>
                    <dd>
                      {r.bindings.map((b, i) => {
                        const id = bindingId(b);
                        const cls = selected.has(id) ? ' is-selected' : hinted?.has(id) ? ' is-hint' : '';
                        return (
                          <span key={b.key} className={`sheet-binding${cls}`}>
                            {i > 0 && <span className="sheet-or">or</span>}
                            <Kbd shortcut={b.key} />
                          </span>
                        );
                      })}
                    </dd>
                  </div>
                );
              })}
            </dl>
          </section>
        ))}
      </div>
    </Dialog>
  );
}

/** Key caps of a (partial) shortcut: "Ctrl + Alt + …" on Windows/Linux, "⌥⌘…" on macOS. */
function Caps({ shortcut, more }: { shortcut: string; more?: boolean }) {
  const mac = isMac();
  const caps = shortcutKeys(shortcut, mac);
  const out: ReactNode[] = [];
  caps.forEach((k, i) => {
    if (k === null) {
      out.push(<span key={i} className="kbd-chord-gap" />);
      return;
    }
    if (!mac && i > 0 && caps[i - 1] !== null) out.push(<span key={`p${i}`} className="sheet-keys-plus">+</span>);
    out.push(<kbd key={i}>{k}</kbd>);
  });
  if (more) {
    if (!mac && caps.length && caps[caps.length - 1] !== null) out.push(<span key="p-more" className="sheet-keys-plus">+</span>);
    out.push(<span key="more" className="sheet-keys-more">…</span>);
  }
  return (
    <span className="kbd-group sheet-keys-caps" aria-hidden="true">
      {out}
    </span>
  );
}

function KeysBar({ held, pending, found, recording, hintCount }: { held: string; pending: string | null; found: Found | null; recording: boolean; hintCount: number }) {
  const mac = isMac();
  let body: ReactNode;
  let state = 'idle';
  if (pending) {
    state = 'chord';
    body = (
      <>
        <Caps shortcut={pending} more />
        <span className="sheet-keys-text">press the second key ({hintCount} chord{hintCount === 1 ? '' : 's'})</span>
      </>
    );
  } else if (found) {
    state = 'found';
    const titles = [...new Set(found.bindings.map((b) => getCommand(b.commandId)?.title ?? b.commandId))];
    body = (
      <>
        <Caps shortcut={found.key} />
        <span className={`sheet-keys-text${titles.length ? ' is-result' : ''}`}>{titles.length ? titles.join(', ') : 'No command uses these keys'}</span>
      </>
    );
  } else if (held) {
    state = 'held';
    body = (
      <>
        <Caps shortcut={held} more />
        <span className="sheet-keys-text">
          {hintCount} shortcut{hintCount === 1 ? '' : 's'}
        </span>
      </>
    );
  } else {
    const mods = mac ? '⌘, ⌥, ⌃ or ⇧' : 'Ctrl, Alt or Shift';
    body = (
      <span className="sheet-keys-text">
        {recording ? 'Recording: press any key or combination to find it · Esc stops' : `Hold ${mods} to highlight its shortcuts · press a combination to find it`}
      </span>
    );
  }
  return (
    <div className="sheet-keys" data-state={state} aria-hidden={state === 'idle' ? undefined : true}>
      {body}
    </div>
  );
}
