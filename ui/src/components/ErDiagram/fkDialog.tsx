// "Create foreign key" (docs/PLAN-M2.md section 3, drag-to-create FK): constraint name, column pairs, ON DELETE /
// ON UPDATE; the DDL comes from the designer's `scriptTable` (original vs. desired table model) and runs through
// `applyDdl` (M1.5 endpoints), so it is the same script the table designer would produce. On success the catalog of
// the schema is reloaded and the new edge appears.
import { Link, Minus, Plus } from 'lucide-react';
import { useEffect, useMemo, useState } from 'react';
import { api, errorMessage } from '../../api/client';
import type { Dialect, ForeignKeyModel, ReferentialAction, TableModel } from '../../api/types';
import { useCatalog } from '../../store/catalog';
import { toast } from '../../store/ui';
import { Dialog } from '../common/Dialog';
import { Select } from '../common/Select';
import { defaultFkName } from './fkName';
import type { DiagramModel, ErNode } from './model';
import type { FkDraft } from './store';

const ACTIONS: Record<Dialect, { del: ReferentialAction[]; upd: ReferentialAction[] }> = {
  tsql: { del: ['NO ACTION', 'CASCADE', 'SET NULL', 'SET DEFAULT'], upd: ['NO ACTION', 'CASCADE', 'SET NULL', 'SET DEFAULT'] },
  plsql: { del: ['NO ACTION', 'CASCADE', 'SET NULL'], upd: ['NO ACTION'] },
  pgsql: { del: ['NO ACTION', 'RESTRICT', 'CASCADE', 'SET NULL', 'SET DEFAULT'], upd: ['NO ACTION', 'RESTRICT', 'CASCADE', 'SET NULL', 'SET DEFAULT'] },
  sqlite: { del: ['NO ACTION'], upd: ['NO ACTION'] },
  // WP-MY begin
  mysql: { del: ['NO ACTION', 'RESTRICT', 'CASCADE', 'SET NULL'], upd: ['NO ACTION', 'RESTRICT', 'CASCADE', 'SET NULL'] },
  // WP-MY end
  // WP-CH begin
  clickhouse: { del: ['NO ACTION'], upd: ['NO ACTION'] },
  // WP-CH end
  // WP-SF begin
  // Snowflake records the actions but enforces no foreign key (informational constraints).
  snowflake: { del: ['NO ACTION', 'CASCADE', 'SET NULL', 'SET DEFAULT', 'RESTRICT'], upd: ['NO ACTION', 'CASCADE', 'SET NULL', 'SET DEFAULT', 'RESTRICT'] },
  // WP-SF end
  // WP-CS begin
  cql: { del: ['NO ACTION'], upd: ['NO ACTION'] },
  // WP-CS end
};

/** First pair guess: the dragged columns, else a column named like the referenced table's key, else the first column. */
function initialPair(from: ErNode, to: ErNode | undefined, d: FkDraft): [string, string] {
  const toCol = d.toColumn ?? to?.pk[0] ?? to?.columns[0]?.name ?? '';
  const guess = to ? from.columns.find((c) => c.name.toLowerCase() === `${to.name}_${toCol}`.toLowerCase() || c.name.toLowerCase() === `${to.name}${toCol}`.toLowerCase()) : undefined;
  return [d.fromColumn ?? guess?.name ?? from.columns.find((c) => !c.pk)?.name ?? from.columns[0]?.name ?? '', toCol];
}

export interface FkDialogProps {
  draft: FkDraft;
  model: DiagramModel;
  connectionId: string;
  database: string | null;
  dialect: Dialect;
  onClose(): void;
}

export function FkDialog({ draft, model, connectionId, database, dialect, onClose }: FkDialogProps) {
  const from = model.byKey.get(draft.from)!;
  const targets = useMemo(() => model.nodes.filter((n) => !n.unresolved && n.columns.length > 0), [model]);
  const [toKey, setToKey] = useState<string>(draft.to ?? targets.find((n) => n.key !== from.key)?.key ?? from.key);
  const to = model.byKey.get(toKey);
  const [pairs, setPairs] = useState<[string, string][]>(() => [initialPair(from, model.byKey.get(draft.to ?? toKey), draft)]);
  const [name, setName] = useState(() => defaultFkName(from.name, to?.name ?? '', dialect));
  const [nameTouched, setNameTouched] = useState(false);
  const actions = ACTIONS[dialect];
  const [onDelete, setOnDelete] = useState<ReferentialAction>('NO ACTION');
  const [onUpdate, setOnUpdate] = useState<ReferentialAction>('NO ACTION');
  const [original, setOriginal] = useState<TableModel | null>(null);
  const [preview, setPreview] = useState<{ sql: string[]; transactional: boolean; warnings: string[] } | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    let cancelled = false;
    api.designerTable(connectionId, database, from.schema || null, from.name)
      .then((t) => !cancelled && setOriginal(t))
      .catch((e) => !cancelled && setError(errorMessage(e)));
    return () => {
      cancelled = true;
    };
  }, [connectionId, database, from.schema, from.name]);

  const fk = useMemo<ForeignKeyModel | null>(() => (to && name.trim() && pairs.every(([a, b]) => a && b)
    ? { name: name.trim(), columns: pairs.map((p) => p[0]), refSchema: to.schema || null, refTable: to.name, refColumns: pairs.map((p) => p[1]), onDelete, onUpdate }
    : null), [to, name, pairs, onDelete, onUpdate]);

  useEffect(() => {
    const ctl = new AbortController();
    const timer = setTimeout(() => {
      if (!original || !fk) {
        setPreview(null);
        return;
      }
      const desired: TableModel = { ...original, foreignKeys: [...original.foreignKeys, fk] };
      api.scriptTable(connectionId, { database, original, desired }, ctl.signal)
        .then((r) => {
          setPreview({ sql: r.statements.map((s) => s.sql), transactional: r.transactional, warnings: [...r.warnings, ...r.statements.map((s) => s.warning).filter((w): w is string => !!w)] });
          setError(null);
        })
        .catch((e) => {
          if (!ctl.signal.aborted) setError(errorMessage(e));
        });
    }, 250);
    return () => {
      clearTimeout(timer);
      ctl.abort();
    };
  }, [original, fk, connectionId, database]);

  const changeTarget = (k: string) => {
    setToKey(k);
    const t = model.byKey.get(k);
    setPairs([initialPair(from, t, { ...draft, to: k, toColumn: null })]);
    if (!nameTouched) setName(defaultFkName(from.name, t?.name ?? '', dialect));
  };

  const apply = async () => {
    if (!preview?.sql.length || busy) return;
    setBusy(true);
    try {
      await api.applyDdl(connectionId, { database, statements: preview.sql, transactional: preview.transactional, schema: from.schema || null });
      toast('success', `Created foreign key ${name.trim()}`);
      await useCatalog.getState().loadSchema(connectionId, database, from.schema, true);
      onClose();
    } catch (e) {
      setError(errorMessage(e));
    } finally {
      setBusy(false);
    }
  };

  const colOptions = (n: ErNode | undefined) => (n?.columns ?? []).map((c) => ({ value: c.name, label: `${c.name}  ${c.type}` }));
  return (
    <Dialog
      title={<span className="confirm-title"><Link size={16} aria-hidden="true" /> Create foreign key</span>}
      ariaLabel="Create foreign key"
      onClose={onClose}
      width={600}
      onSubmit={() => void apply()}
      footer={(
        <>
          <button type="button" className="btn" onClick={onClose}>Cancel</button>
          <button type="button" className="btn btn-primary" disabled={!preview?.sql.length || busy} onClick={() => void apply()}>{busy ? 'Creating…' : 'Create foreign key'}</button>
        </>
      )}
    >
      <div className="form-grid er-fk-form">
        <label className="form-label" htmlFor="er-fk-name">Name</label>
        <input id="er-fk-name" className="input mono" value={name} onChange={(e) => { setName(e.target.value); setNameTouched(true); }} spellCheck={false} />
        <span className="form-label">Table</span>
        <div className="er-fk-fixed mono">{from.label}</div>
        <label className="form-label" htmlFor="er-fk-to">References</label>
        <Select id="er-fk-to" value={toKey} onChange={changeTarget} options={targets.map((n) => ({ value: n.key, label: n.label }))} mono />
        <span className="form-label">Columns</span>
        <div className="er-fk-pairs">
          {pairs.map(([a, b], i) => (
            <div className="er-fk-pair" key={i}>
              <Select aria-label={`Column ${i + 1} of ${from.name}`} value={a} onChange={(v) => setPairs(pairs.map((p, j) => (j === i ? [v, p[1]] : p)))} options={colOptions(from)} mono size="sm" />
              <span aria-hidden="true" className="er-fk-arrow">→</span>
              <Select aria-label={`Referenced column ${i + 1}`} value={b} onChange={(v) => setPairs(pairs.map((p, j) => (j === i ? [p[0], v] : p)))} options={colOptions(to)} mono size="sm" />
              {pairs.length > 1 && (
                <button type="button" className="icon-btn sm" aria-label={`Remove column pair ${i + 1}`} title="Remove this column pair" onClick={() => setPairs(pairs.filter((_, j) => j !== i))}><Minus size={14} /></button>
              )}
            </div>
          ))}
          <button type="button" className="btn btn-xs btn-ghost er-fk-addpair" onClick={() => setPairs([...pairs, ['', '']])}><Plus size={12} /> Add column pair</button>
        </div>
        <label className="form-label" htmlFor="er-fk-del">On delete</label>
        <Select id="er-fk-del" value={onDelete} onChange={(v) => setOnDelete(v as ReferentialAction)} options={actions.del.map((a) => ({ value: a, label: a }))} />
        <label className="form-label" htmlFor="er-fk-upd">On update</label>
        <Select id="er-fk-upd" value={onUpdate} onChange={(v) => setOnUpdate(v as ReferentialAction)} options={actions.upd.map((a) => ({ value: a, label: a }))} disabled={actions.upd.length < 2} />
      </div>
      <div className="er-fk-preview">
        <div className="er-fk-preview-title">DDL</div>
        {preview ? <pre className="er-fk-sql">{preview.sql.join(';\n\n')}{preview.sql.length ? ';' : ''}</pre> : <div className="er-fk-sql muted">{original ? 'Choose the columns…' : 'Loading the table definition…'}</div>}
        {preview?.warnings.map((w) => <div key={w} className="form-help">{w}</div>)}
        {error && <div className="form-error" role="alert">{error}</div>}
      </div>
    </Dialog>
  );
}
