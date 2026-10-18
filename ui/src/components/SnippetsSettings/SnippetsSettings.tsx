// Settings → Snippets (PLAN-M1.5 A4): user snippets (name, prefix, dialect filter, Monaco snippet body) stored as
// Settings.snippets, next to the read-only built-ins. A user snippet with a built-in's prefix overrides it.
import { Braces, Copy, Plus, Save, Trash2, Undo2 } from 'lucide-react';
import { useMemo, useState } from 'react';
import { Select } from '../common/Select';
import type { Dialect, Snippet } from '../../api/types';
import { BUILTIN_SNIPPETS, newSnippetId, snippetPreview, validateSnippet, type SnippetDef } from '../../snippets';
import { useSettings } from '../../store/settings';
import { displayShortcut } from '../../commands/keys';
import './SnippetsSettings.css';

const DIALECTS: { id: Dialect; label: string }[] = [
  { id: 'tsql', label: 'SQL Server' },
  { id: 'plsql', label: 'Oracle' },
  { id: 'sqlite', label: 'SQLite' },
];

type Selection = { kind: 'user'; id: string } | { kind: 'builtin'; id: string } | null;

export interface SnippetsSettingsProps {
  snippets: readonly Snippet[];
  onChange: (next: Snippet[]) => void;
}

function dialectText(d: Dialect[] | null): string {
  if (!d || d.length === 0 || d.length === 3) return 'All dialects';
  return d.map((x) => DIALECTS.find((y) => y.id === x)?.label ?? x).join(', ');
}

export function SnippetsSettings({ snippets, onChange }: SnippetsSettingsProps) {
  const [query, setQuery] = useState('');
  const [dialect, setDialect] = useState<Dialect | 'all'>('all');
  const [sel, setSel] = useState<Selection>(snippets[0] ? { kind: 'user', id: snippets[0].id } : null);
  const [draft, setDraft] = useState<Snippet | null>(snippets[0] ?? null);
  const [touched, setTouched] = useState(false);

  const matches = (s: { prefix: string; name: string; dialects: Dialect[] | null }) =>
    (dialect === 'all' || !s.dialects || s.dialects.length === 0 || s.dialects.includes(dialect))
    && (!query || `${s.prefix} ${s.name}`.toLowerCase().includes(query.toLowerCase()));
  const userList = snippets.filter(matches);
  const overridden = new Set(snippets.map((s) => s.prefix.toLowerCase()));
  const builtins = BUILTIN_SNIPPETS.filter(matches);

  const selectedBuiltin: SnippetDef | null = sel?.kind === 'builtin' ? BUILTIN_SNIPPETS.find((b) => b.id === sel.id) ?? null : null;
  const others = snippets.filter((s) => s.id !== draft?.id);
  const problems = useMemo(() => (draft ? validateSnippet(draft, others.filter((o) => overlaps(o.dialects, draft.dialects))) : []), [draft, others]);
  const problem = (f: 'name' | 'prefix' | 'body') => (touched ? problems.find((p) => p.field === f)?.message : undefined);
  const saved = draft ? snippets.find((s) => s.id === draft.id) : undefined;
  const dirty = !!draft && JSON.stringify(saved) !== JSON.stringify(draft);

  const pickUser = (s: Snippet) => { setSel({ kind: 'user', id: s.id }); setDraft({ ...s }); setTouched(false); };
  const pickBuiltin = (b: SnippetDef) => { setSel({ kind: 'builtin', id: b.id }); setDraft(null); };
  const create = (from?: Partial<Snippet>) => {
    const s: Snippet = { id: newSnippetId(snippets), name: from?.name ?? 'New snippet', prefix: from?.prefix ?? '', dialects: from?.dialects ?? null, body: from?.body ?? '', description: from?.description ?? null };
    onChange([...snippets, s]);
    setSel({ kind: 'user', id: s.id });
    setDraft(s);
    setTouched(false);
  };
  const save = () => {
    setTouched(true);
    if (!draft || problems.length) return;
    onChange(snippets.map((s) => (s.id === draft.id ? draft : s)));
  };
  const remove = () => {
    if (!draft) return;
    const next = snippets.filter((s) => s.id !== draft.id);
    onChange(next);
    if (next[0]) pickUser(next[0]); else { setSel(null); setDraft(null); }
  };
  const toggleDialect = (d: Dialect) => {
    if (!draft) return;
    const cur = draft.dialects && draft.dialects.length ? draft.dialects : DIALECTS.map((x) => x.id);
    const next = cur.includes(d) ? cur.filter((x) => x !== d) : [...cur, d];
    setDraft({ ...draft, dialects: next.length === DIALECTS.length ? null : next });
  };

  return (
    <div className="snip" data-command-scope="snippets">
      <div className="snip-toolbar">
        <Braces size={16} strokeWidth={1.5} className="snip-icon" aria-hidden />
        <span className="snip-title">Snippets</span>
        <span className="snip-hint">Type a prefix at the start of a statement, or press {displayShortcut('Ctrl+J')} in the editor.</span>
        <span className="flex-1" />
        <input className="input snip-search" placeholder="Filter snippets" aria-label="Filter snippets" value={query} onChange={(e) => setQuery(e.target.value)} />
        <Select<Dialect | 'all'>
          className="snip-dialect"
          aria-label="Dialect"
          value={dialect}
          options={[{ value: 'all', label: 'All dialects' }, ...DIALECTS.map((d) => ({ value: d.id, label: d.label }))]}
          onChange={setDialect}
        />
        <button className="btn btn-primary btn-xs" onClick={() => create()}><Plus size={14} strokeWidth={1.5} aria-hidden /> New snippet</button>
      </div>
      <div className="snip-body">
        <div className="snip-list" role="listbox" aria-label="Snippets">
          <div className="snip-group">Your snippets</div>
          {userList.length === 0 && <div className="snip-empty">No snippets yet. <button className="link-btn" onClick={() => create()}>Create one</button></div>}
          {userList.map((s) => (
            <div key={s.id} role="option" tabIndex={0} aria-selected={sel?.kind === 'user' && sel.id === s.id}
              className={`snip-item${sel?.kind === 'user' && sel.id === s.id ? ' selected' : ''}`}
              onClick={() => pickUser(s)} onKeyDown={(e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); pickUser(s); } }}>
              <span className="snip-prefix">{s.prefix || '(no prefix)'}</span>
              <span className="snip-name">{s.name}</span>
              <span className="snip-tag">{dialectText(s.dialects)}</span>
            </div>
          ))}
          <div className="snip-group">Built-in</div>
          {builtins.map((b) => (
            <div key={b.id} role="option" tabIndex={0} aria-selected={sel?.kind === 'builtin' && sel.id === b.id}
              className={`snip-item${sel?.kind === 'builtin' && sel.id === b.id ? ' selected' : ''}${overridden.has(b.prefix) ? ' overridden' : ''}`}
              onClick={() => pickBuiltin(b)} onKeyDown={(e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); pickBuiltin(b); } }}
              title={overridden.has(b.prefix) ? 'Overridden by one of your snippets' : undefined}>
              <span className="snip-prefix">{b.prefix}</span>
              <span className="snip-name">{b.name}</span>
              <span className="snip-tag">{dialectText(b.dialects)}</span>
            </div>
          ))}
        </div>

        <div className="snip-editor">
          {selectedBuiltin && (
            <>
              <div className="snip-ro-head">
                <div>
                  <div className="snip-ro-name">{selectedBuiltin.name}</div>
                  <div className="muted">Prefix <code>{selectedBuiltin.prefix}</code> · {dialectText(selectedBuiltin.dialects)} · built-in, read-only</div>
                </div>
                <button className="btn btn-xs" onClick={() => create({ name: selectedBuiltin.name, prefix: selectedBuiltin.prefix, dialects: selectedBuiltin.dialects, body: selectedBuiltin.body })}>
                  <Copy size={14} strokeWidth={1.5} aria-hidden /> Customize
                </button>
              </div>
              <div className="form-label">Body</div>
              <pre className="snip-code">{selectedBuiltin.body}</pre>
              <div className="form-label">Inserts</div>
              <pre className="snip-code snip-preview">{snippetPreview(selectedBuiltin.body)}</pre>
            </>
          )}
          {draft && (
            <form className="snip-form" onSubmit={(e) => { e.preventDefault(); save(); }}>
              <div className="snip-row">
                <label className="snip-field">
                  <span className="form-label">Name</span>
                  <input aria-label="Name" className="input" value={draft.name} onChange={(e) => setDraft({ ...draft, name: e.target.value })} aria-invalid={!!problem('name')} />
                  {problem('name') && <span className="form-error">{problem('name')}</span>}
                </label>
                <label className="snip-field snip-field-prefix">
                  <span className="form-label">Prefix</span>
                  <input aria-label="Prefix" className="input mono" value={draft.prefix} onChange={(e) => setDraft({ ...draft, prefix: e.target.value.trim() })} aria-invalid={!!problem('prefix')} />
                  {problem('prefix') && <span className="form-error">{problem('prefix')}</span>}
                </label>
              </div>
              <fieldset className="snip-dialects">
                <legend className="form-label">Dialects</legend>
                {DIALECTS.map((d) => (
                  <label key={d.id} className="check">
                    <input type="checkbox" checked={!draft.dialects || draft.dialects.length === 0 || draft.dialects.includes(d.id)} onChange={() => toggleDialect(d.id)} /> {d.label}
                  </label>
                ))}
              </fieldset>
              <label className="snip-field">
                <span className="form-label">Description (optional)</span>
                <input className="input" value={draft.description ?? ''} onChange={(e) => setDraft({ ...draft, description: e.target.value || null })} />
              </label>
              <label className="snip-field">
                <span className="form-label">Body</span>
                <textarea aria-label="Body" className="input mono snip-textarea" rows={8} spellCheck={false} value={draft.body}
                  onChange={(e) => setDraft({ ...draft, body: e.target.value })} aria-invalid={!!problem('body')} aria-describedby="snip-syntax" />
                {problem('body') && <span className="form-error">{problem('body')}</span>}
                <span id="snip-syntax" className="form-help">Tab stops: <code>$1</code>, <code>{'${1:default}'}</code>; final cursor <code>$0</code>; same number = same text. <code>\$</code> for a literal dollar.</span>
              </label>
              {draft.body && (
                <>
                  <div className="form-label">Inserts</div>
                  <pre className="snip-code snip-preview">{snippetPreview(draft.body)}</pre>
                </>
              )}
              <div className="snip-actions">
                <button type="button" className="btn btn-danger btn-xs" onClick={remove}><Trash2 size={14} strokeWidth={1.5} aria-hidden /> Delete</button>
                <button type="button" className="btn btn-xs" onClick={() => create({ ...draft, prefix: `${draft.prefix}2`, name: `${draft.name} (copy)` })}><Copy size={14} strokeWidth={1.5} aria-hidden /> Duplicate</button>
                <span className="flex-1" />
                {dirty && saved && <button type="button" className="btn btn-xs" onClick={() => { setDraft({ ...saved }); setTouched(false); }}><Undo2 size={14} strokeWidth={1.5} aria-hidden /> Revert</button>}
                <button type="submit" className="btn btn-primary btn-xs" ><Save size={14} strokeWidth={1.5} aria-hidden /> Save</button>
              </div>
            </form>
          )}
          {!draft && !selectedBuiltin && (
            <div className="snip-empty-editor">
              <Braces size={24} strokeWidth={1.5} aria-hidden />
              <div>Select a snippet or create your own</div>
              <button className="btn btn-primary" onClick={() => create()}><Plus size={14} strokeWidth={1.5} aria-hidden /> New snippet</button>
            </div>
          )}
        </div>
      </div>
    </div>
  );
}

function overlaps(a: Dialect[] | null, b: Dialect[] | null): boolean {
  if (!a || !a.length || !b || !b.length) return true;
  return a.some((x) => b.includes(x));
}

/** Connected to Settings.snippets (persisted engine-side through PUT /settings). */
export function SnippetsSettingsConnected() {
  const snippets = useSettings((s) => (s.settings as { snippets?: Snippet[] }).snippets ?? []);
  return <SnippetsSettings snippets={snippets} onChange={(next) => useSettings.getState().update({ snippets: next })} />;
}

export default SnippetsSettingsConnected;
