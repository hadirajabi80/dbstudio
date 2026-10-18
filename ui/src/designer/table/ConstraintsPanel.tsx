// Keys & Indexes, Foreign Keys and Checks tabs of the table designer.
import { ArrowDownWideNarrow, ArrowUpNarrowWide, Plus, Trash2 } from 'lucide-react';
import { useMemo, type ReactNode } from 'react';
import { Select } from '../../components/common/Select';
import type { CatalogSnapshot, DesignerFeatures, Dialect, ForeignKeyModel, ReferentialAction, TableModel } from '../../api/types';
import { singularize } from '../../codegen/naming';
import {
  addCheck, addForeignKey, addIndex, addUnique, defaultConstraintName, defaultPkClustered, referentialActions, removeCheck, removeForeignKey, removeIndex,
  removeUnique, updateCheck, updateForeignKey, updateIndex, updateUnique,
} from './model';

interface Props {
  table: TableModel;
  dialect: Dialect;
  features: DesignerFeatures | null;
  readOnly: boolean;
  catalog: CatalogSnapshot | null;
  onChange(t: TableModel): void;
}

/** Toggle buttons for picking an ordered subset of the table's columns. */
function ColumnChips(p: { all: string[]; selected: string[]; onChange(next: string[]): void; disabled: boolean; label: string; extra?: (name: string) => ReactNode }) {
  return (
    <span className="dz-chips" role="group" aria-label={p.label}>
      {p.all.map((name) => {
        const i = p.selected.indexOf(name);
        const on = i >= 0;
        return (
          <span key={name} className="dz-chips">
            <button
              type="button"
              className={`dz-chip${on ? ' on' : ''}`}
              aria-pressed={on}
              disabled={p.disabled}
              title={on ? `Remove ${name}` : `Add ${name}`}
              onClick={() => p.onChange(on ? p.selected.filter((x) => x !== name) : [...p.selected, name])}
            >
              {on && p.selected.length > 1 ? `${i + 1}. ` : ''}
              {name}
            </button>
            {on && p.extra?.(name)}
          </span>
        );
      })}
    </span>
  );
}

export function KeysPanel({ table, dialect, features, readOnly, onChange }: Props) {
  const names = table.columns.map((c) => c.name).filter(Boolean);
  const pk = table.primaryKey;
  return (
    <div className="dz-list">
      <div className="dz-card" aria-label="Primary key">
        <span className="dz-card-title">Primary key</span>
        <label className="dz-field">
          Name
          <input
            className="input xs mono"
            value={pk?.name ?? ''}
            placeholder={defaultConstraintName(table, dialect, 'PK', [])}
            disabled={readOnly || !pk}
            onChange={(e) => pk && onChange({ ...table, primaryKey: { ...pk, name: e.target.value || null } })}
          />
        </label>
        <ColumnChips
          label="Primary key columns"
          all={names}
          selected={pk?.columns ?? []}
          disabled={readOnly}
          onChange={(cols) =>
            onChange({
              ...table,
              primaryKey: cols.length ? { name: pk?.name ?? null, columns: cols, clustered: pk?.clustered ?? defaultPkClustered(dialect, table) } : null,
              columns: table.columns.map((c) => (cols.includes(c.name) ? { ...c, nullable: false } : c)),
            })
          }
        />
        {features?.clusteredIndexes && pk && (
          <label className="check sm">
            <input type="checkbox" checked={pk.clustered} disabled={readOnly} onChange={(e) => onChange({ ...table, primaryKey: { ...pk, clustered: e.target.checked } })} />
            Clustered
          </label>
        )}
      </div>

      <div className="dz-card" aria-label="Unique constraints">
        <span className="dz-card-title">Unique constraints</span>
        <button type="button" className="btn btn-xs" disabled={readOnly || !names.length} onClick={() => onChange(addUnique(table, dialect))}>
          <Plus size={12} /> Unique
        </button>
      </div>
      {table.uniques.map((u, i) => (
        <div key={i} className="dz-card" aria-label={`Unique constraint ${u.name ?? i + 1}`}>
          <label className="dz-field">
            Name
            <input className="input xs mono" value={u.name ?? ''} disabled={readOnly} onChange={(e) => onChange(updateUnique(table, i, { name: e.target.value || null }))} />
          </label>
          <ColumnChips label="Unique columns" all={names} selected={u.columns} disabled={readOnly} onChange={(cols) => onChange(updateUnique(table, i, { columns: cols }))} />
          <span className="dz-spacer" />
          <button type="button" className="icon-btn" aria-label={`Remove unique constraint ${u.name ?? ''}`} title="Remove" disabled={readOnly} onClick={() => onChange(removeUnique(table, i))}>
            <Trash2 size={14} />
          </button>
        </div>
      ))}

      <div className="dz-card" aria-label="Indexes">
        <span className="dz-card-title">Indexes</span>
        <button type="button" className="btn btn-xs" disabled={readOnly || !names.length} onClick={() => onChange(addIndex(table, dialect))}>
          <Plus size={12} /> Index
        </button>
      </div>
      {table.indexes.map((x, i) => (
        <div key={i} className="dz-card" aria-label={`Index ${x.name}`}>
          <label className="dz-field">
            Name
            <input className="input xs mono" value={x.name} disabled={readOnly} onChange={(e) => onChange(updateIndex(table, i, { name: e.target.value }))} />
          </label>
          <label className="check sm">
            <input type="checkbox" checked={x.unique} disabled={readOnly} onChange={(e) => onChange(updateIndex(table, i, { unique: e.target.checked }))} />
            Unique
          </label>
          {features?.clusteredIndexes && (
            <label className="check sm">
              <input type="checkbox" checked={x.clustered} disabled={readOnly} onChange={(e) => onChange(updateIndex(table, i, { clustered: e.target.checked }))} />
              Clustered
            </label>
          )}
          <ColumnChips
            label="Index columns"
            all={names}
            selected={x.columns.map((c) => c.name)}
            disabled={readOnly}
            onChange={(cols) => onChange(updateIndex(table, i, { columns: cols.map((n) => x.columns.find((c) => c.name === n) ?? { name: n, desc: false }) }))}
            extra={(name) => {
              const c = x.columns.find((k) => k.name === name)!;
              return (
                <button
                  type="button"
                  className="icon-btn"
                  aria-label={`${name}: ${c.desc ? 'descending' : 'ascending'} (toggle)`}
                  title={c.desc ? 'Descending' : 'Ascending'}
                  disabled={readOnly}
                  onClick={() => onChange(updateIndex(table, i, { columns: x.columns.map((k) => (k.name === name ? { ...k, desc: !k.desc } : k)) }))}
                >
                  {c.desc ? <ArrowDownWideNarrow size={13} /> : <ArrowUpNarrowWide size={13} />}
                </button>
              );
            }}
          />
          {features?.includedColumns && (
            <span className="dz-field">
              Include
              <ColumnChips label="Included columns" all={names.filter((n) => !x.columns.some((c) => c.name === n))} selected={x.include} disabled={readOnly} onChange={(cols) => onChange(updateIndex(table, i, { include: cols }))} />
            </span>
          )}
          {features?.filteredIndexes && (
            <label className="dz-field">
              WHERE
              <input className="input xs mono" style={{ width: 220 }} value={x.filter ?? ''} placeholder="filter (optional)" disabled={readOnly} onChange={(e) => onChange(updateIndex(table, i, { filter: e.target.value || null }))} />
            </label>
          )}
          <span className="dz-spacer" />
          <button type="button" className="icon-btn" aria-label={`Remove index ${x.name}`} title="Remove" disabled={readOnly} onClick={() => onChange(removeIndex(table, i))}>
            <Trash2 size={14} />
          </button>
        </div>
      ))}
    </div>
  );
}

interface RefTable {
  schema: string;
  name: string;
  pk: string[];
  columns: string[];
}

/** Local columns that most likely reference `ref`'s key: `CustomerId` / `customer_id` for Customers.Id. */
function guessColumns(table: TableModel, ref: RefTable): string[] {
  const singular = singularize(ref.name).toLowerCase().replace(/[^a-z0-9]/g, '');
  return ref.pk.map((k) => {
    const key = k.toLowerCase().replace(/[^a-z0-9]/g, '');
    const want = [`${singular}${key}`, key === 'id' ? `${singular}id` : `${key}`];
    return table.columns.find((c) => want.includes(c.name.toLowerCase().replace(/[^a-z0-9]/g, '')))?.name ?? '';
  });
}

export function ForeignKeysPanel({ table, dialect, readOnly, catalog, onChange }: Props) {
  const names = table.columns.map((c) => c.name).filter(Boolean);
  const refs: RefTable[] = useMemo(() => {
    const out: RefTable[] = [];
    for (const s of catalog?.schemas ?? []) {
      for (const o of s.objects) {
        if (o.t !== 'table') continue;
        out.push({ schema: s.name, name: o.n, pk: o.pk ?? (o.c ?? []).filter((c) => c[3]).map((c) => c[0]), columns: (o.c ?? []).map((c) => c[0]) });
      }
    }
    return out;
  }, [catalog]);
  const self: RefTable = { schema: table.schema ?? '', name: table.name, pk: table.primaryKey?.columns ?? [], columns: names };
  const findRef = (f: ForeignKeyModel) =>
    f.refTable === table.name && (f.refSchema ?? '') === (table.schema ?? '') ? self : refs.find((r) => r.name === f.refTable && (!f.refSchema || r.schema === f.refSchema));

  return (
    <div className="dz-list">
      <div className="dz-card">
        <span className="dz-card-title">Foreign keys</span>
        <button type="button" className="btn btn-xs" disabled={readOnly || !names.length} onClick={() => onChange(addForeignKey(table, dialect))}>
          <Plus size={12} /> Foreign key
        </button>
        {!catalog && <span className="dz-sub">Load the schema in the explorer to pick referenced tables.</span>}
      </div>
      {table.foreignKeys.map((f, i) => {
        const ref = findRef(f);
        // Match the option of the resolved table (SQLite and same-schema FKs come back with refSchema null).
        const refValue = ref ? `${ref.schema}\u0001${ref.name}` : f.refTable ? `${f.refSchema ?? ''}\u0001${f.refTable}` : '';
        return (
          <div key={i} className="dz-card" aria-label={`Foreign key ${f.name ?? i + 1}`}>
            <label className="dz-field">
              Name
              <input className="input xs mono" value={f.name ?? ''} disabled={readOnly} onChange={(e) => onChange(updateForeignKey(table, i, { name: e.target.value || null }))} />
            </label>
            <ColumnChips label="Foreign key columns" all={names} selected={f.columns} disabled={readOnly} onChange={(cols) => onChange(updateForeignKey(table, i, { columns: cols }))} />
            <label className="dz-field">
              References
              <Select
                size="xs"
                mono
                value={refValue}
                disabled={readOnly}
                placeholder={f.refTable ?? '(choose a table)'}
                menuMinWidth={200}
                options={[
                  { value: '', label: '(choose a table)' },
                  ...(table.name ? [{ value: `${self.schema}\u0001${self.name}`, label: `${self.name} (this table)` }] : []),
                  ...refs.map((r) => ({ value: `${r.schema}\u0001${r.name}`, label: `${r.schema && dialect !== 'sqlite' ? `${r.schema}.` : ''}${r.name}` })),
                ]}
                onChange={(v) => {
                  const [schema, name] = v.split('\u0001');
                  const r = name === self.name && schema === self.schema ? self : refs.find((x) => x.schema === schema && x.name === name);
                  if (!r) return;
                  const guessed = f.columns.length ? f.columns : guessColumns(table, r).filter(Boolean);
                  onChange(updateForeignKey(table, i, {
                    refSchema: dialect === 'sqlite' ? null : r.schema, refTable: r.name, refColumns: r.pk,
                    columns: guessed.length === r.pk.length ? guessed : f.columns,
                    name: f.name && !f.name.startsWith(defaultConstraintName(table, dialect, 'FK', [])) ? f.name : defaultConstraintName(table, dialect, 'FK', [r.name]),
                  }));
                }}
              />
            </label>
            {ref && (
              <ColumnChips label="Referenced columns" all={ref.columns} selected={f.refColumns} disabled={readOnly} onChange={(cols) => onChange(updateForeignKey(table, i, { refColumns: cols }))} />
            )}
            <label className="dz-field">
              On delete
              <Select<ReferentialAction>
                size="xs"
                value={f.onDelete}
                disabled={readOnly}
                options={referentialActions(dialect, 'delete').map((a) => ({ value: a, label: a }))}
                onChange={(onDelete) => onChange(updateForeignKey(table, i, { onDelete }))}
              />
            </label>
            {dialect !== 'plsql' && (
              <label className="dz-field">
                On update
                <Select<ReferentialAction>
                  size="xs"
                  value={f.onUpdate}
                  disabled={readOnly}
                  options={referentialActions(dialect, 'update').map((a) => ({ value: a, label: a }))}
                  onChange={(onUpdate) => onChange(updateForeignKey(table, i, { onUpdate }))}
                />
              </label>
            )}
            <span className="dz-spacer" />
            <button type="button" className="icon-btn" aria-label={`Remove foreign key ${f.name ?? ''}`} title="Remove" disabled={readOnly} onClick={() => onChange(removeForeignKey(table, i))}>
              <Trash2 size={14} />
            </button>
          </div>
        );
      })}
    </div>
  );
}

export function ChecksPanel({ table, dialect, readOnly, onChange }: Props) {
  return (
    <div className="dz-list">
      <div className="dz-card">
        <span className="dz-card-title">Check constraints</span>
        <button type="button" className="btn btn-xs" disabled={readOnly} onClick={() => onChange(addCheck(table, dialect))}>
          <Plus size={12} /> Check
        </button>
      </div>
      {table.checks.map((c, i) => (
        <div key={i} className="dz-card" aria-label={`Check ${c.name ?? i + 1}`}>
          <label className="dz-field">
            Name
            <input className="input xs mono" value={c.name ?? ''} disabled={readOnly} onChange={(e) => onChange(updateCheck(table, i, { name: e.target.value || null }))} />
          </label>
          <label className="dz-field" style={{ flex: 1 }}>
            Expression
            <input
              className="input xs mono"
              style={{ flex: 1, width: 'auto' }}
              value={c.expression}
              placeholder={dialect === 'plsql' ? 'AGE >= 0' : 'Age >= 0'}
              disabled={readOnly}
              onChange={(e) => onChange(updateCheck(table, i, { expression: e.target.value }))}
            />
          </label>
          <button type="button" className="icon-btn" aria-label={`Remove check ${c.name ?? ''}`} title="Remove" disabled={readOnly} onClick={() => onChange(removeCheck(table, i))}>
            <Trash2 size={14} />
          </button>
        </div>
      ))}
    </div>
  );
}
