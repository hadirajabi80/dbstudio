// Snowflake table options in the table designer (TableOptions.extra): TRANSIENT (new tables only), Time Travel retention
// in days (DATA_RETENTION_TIME_IN_DAYS) and CHANGE_TRACKING.
import type { DesignerOptionsPanelProps } from '../../designer/table/optionsPanels';

export default function SnowflakeTableOptions({ table, existing, disabled, onChange }: DesignerOptionsPanelProps) {
  const extra = table.options.extra ?? {};
  const set = (key: string, value: string | null) => {
    const next = { ...extra };
    if (value) next[key] = value;
    else delete next[key];
    onChange(next);
  };
  const transient = extra.kind === 'transient';
  return (
    <div className="dz-engine" style={{ display: 'flex', flexWrap: 'wrap', gap: 12, alignItems: 'flex-end', padding: '6px 12px', borderBottom: '1px solid var(--border)' }} data-testid="sf-table-options">
      <label className="check sm" title="A transient table has no Fail-safe and at most 1 day of Time Travel (fixed when the table is created)">
        <input type="checkbox" checked={transient} disabled={disabled || existing} onChange={(e) => set('kind', e.target.checked ? 'transient' : null)} />
        TRANSIENT
      </label>
      <label className="dz-field" title="DATA_RETENTION_TIME_IN_DAYS: Time Travel retention, 0 to 90 days (empty = the schema's default)">
        Retention (days)
        <input
          className="input mono"
          style={{ width: 70 }}
          type="number"
          min={0}
          max={transient ? 1 : 90}
          value={extra.retentionDays ?? ''}
          disabled={disabled}
          onChange={(e) => set('retentionDays', e.target.value === '' ? null : String(Math.max(0, Math.min(90, Math.floor(Number(e.target.value) || 0)))))}
        />
      </label>
      <label className="check sm" title="CHANGE_TRACKING: lets streams and CHANGES queries read the table's changes">
        <input type="checkbox" checked={extra.changeTracking === 'true'} disabled={disabled} onChange={(e) => set('changeTracking', e.target.checked ? 'true' : null)} />
        CHANGE_TRACKING
      </label>
    </div>
  );
}
