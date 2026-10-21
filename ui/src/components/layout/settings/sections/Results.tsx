import { displayShortcut } from '../../../../commands/keys';
import { useSettings, type FullSettings } from '../../../../store/settings';
import { Card, Num, Row, Select, ToggleRow } from '../controls';

export function ResultsSection() {
  const s = useSettings((x) => x.settings) as FullSettings;
  const up = useSettings.getState().update;
  return (
    <>
      <Card title="Results" description="Query results in the console.">
        <Row label="Default row limit" htmlFor="set-max" hint="0 = no limit" keywords="max rows fetch">
          <Num id="set-max" value={s.results.maxRows} min={0} max={10_000_000} onChange={(v) => up({ results: { maxRows: v } })} />
        </Row>
        <Row label="NULL shown as" htmlFor="set-null" keywords="null text empty">
          <input id="set-null" className="input settings-text" value={s.results.nullText} onChange={(e) => up({ results: { nullText: e.target.value } })} />
        </Row>
        <Row label="Dates" htmlFor="set-date" keywords="date time format locale iso">
          <Select id="set-date" value={s.results.dateFormat} options={[['iso', 'ISO 8601'], ['locale', 'System locale']]} onChange={(v) => up({ results: { dateFormat: v } })} />
        </Row>
      </Card>
      <Card title="Data tab">
        <Row label="Data tab page size" htmlFor="set-page" hint="Rows loaded per page when browsing a table" keywords="page rows">
          <Num id="set-page" value={s.grid.pageSize} min={50} max={100000} onChange={(v) => up({ grid: { pageSize: v } })} />
        </Row>
      </Card>
      <Card title="Editing data" description="Saving changes made in a grid.">
        <ToggleRow
          id="set-verify"
          label="Verify unchanged values when saving edits"
          hint="Optimistic concurrency: a row changed by someone else is not overwritten"
          keywords="concurrency conflict save"
          checked={s.grid.verifyUnchanged}
          onChange={(v) => up({ grid: { verifyUnchanged: v } })}
        />
        <ToggleRow
          id="set-showsql"
          label="Show the SQL before saving edits"
          hint={`Off: ${displayShortcut('Mod+S')} saves directly`}
          keywords="preview sql save"
          checked={!!s.grid.showSqlBeforeSave}
          onChange={(v) => up({ grid: { showSqlBeforeSave: v } })}
        />
      </Card>
    </>
  );
}
