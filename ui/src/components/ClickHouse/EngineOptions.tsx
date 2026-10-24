// ClickHouse table options in the table designer: ENGINE, ORDER BY, PARTITION BY, PRIMARY KEY, SAMPLE BY, TTL, SETTINGS
// (TableOptions.extra). On an existing table only TTL and SETTINGS can change (ALTER … MODIFY TTL / MODIFY SETTING).
import type { DesignerOptionsPanelProps } from '../../designer/table/optionsPanels';

const ENGINES = [
  'MergeTree', 'ReplacingMergeTree', 'SummingMergeTree', 'AggregatingMergeTree', 'CollapsingMergeTree', 'VersionedCollapsingMergeTree',
  'ReplicatedMergeTree', 'Memory', 'Log', 'TinyLog', 'StripeLog',
];

const FIELDS: { key: string; label: string; placeholder: string; width: number; fixed?: boolean; mergeTree?: boolean; title: string }[] = [
  { key: 'orderBy', label: 'ORDER BY', placeholder: 'primary key columns', width: 190, fixed: true, mergeTree: true, title: 'Sorting key expression; empty = the primary key columns (tuple() without one)' },
  { key: 'partitionBy', label: 'PARTITION BY', placeholder: 'toYYYYMM(date)', width: 160, fixed: true, mergeTree: true, title: 'Partition expression' },
  { key: 'primaryKey', label: 'PRIMARY KEY', placeholder: 'same as ORDER BY', width: 150, fixed: true, mergeTree: true, title: 'Separate primary key expression (a prefix of ORDER BY)' },
  { key: 'sampleBy', label: 'SAMPLE BY', placeholder: 'intHash32(id)', width: 130, fixed: true, mergeTree: true, title: 'Sampling expression (must be part of the primary key)' },
  { key: 'ttl', label: 'TTL', placeholder: 'date + INTERVAL 90 DAY', width: 190, mergeTree: true, title: 'Table TTL expression' },
  { key: 'settings', label: 'SETTINGS', placeholder: 'index_granularity = 8192', width: 200, mergeTree: true, title: 'Table settings, name = value separated by commas' },
];

export default function EngineOptions({ table, existing, disabled, onChange }: DesignerOptionsPanelProps) {
  const extra = table.options.extra ?? {};
  const set = (key: string, value: string) => {
    const next = { ...extra };
    if (value) next[key] = value;
    else delete next[key];
    onChange(next);
  };
  const engine = extra.engine ?? 'MergeTree';
  const mergeTree = engine.endsWith('MergeTree');
  return (
    <div className="dz-engine" style={{ display: 'flex', flexWrap: 'wrap', gap: 8, alignItems: 'flex-end', padding: '6px 12px', borderBottom: '1px solid var(--border)' }} data-testid="ch-engine-options">
      <label className="dz-field" title="Table engine">
        ENGINE
        <input
          className="input mono"
          style={{ width: 170 }}
          list="ch-engines"
          value={engine}
          disabled={disabled || existing}
          onChange={(e) => set('engine', e.target.value)}
        />
        <datalist id="ch-engines">
          {ENGINES.map((en) => (
            <option key={en} value={en} />
          ))}
        </datalist>
      </label>
      {mergeTree &&
        FIELDS.map((f) => (
          <label key={f.key} className="dz-field" title={f.title}>
            {f.label}
            <input
              className="input mono"
              style={{ width: f.width }}
              value={extra[f.key] ?? ''}
              placeholder={f.placeholder}
              disabled={disabled || (existing && f.fixed)}
              onChange={(e) => set(f.key, e.target.value)}
            />
          </label>
        ))}
    </div>
  );
}
