import { displayShortcut } from '../../../../commands/keys';
import { useSettings, type FullSettings } from '../../../../store/settings';
import { Card, Num, Row, Select, ToggleRow } from '../controls';

export function FormattingSection() {
  const s = useSettings((x) => x.settings) as FullSettings;
  const up = useSettings.getState().update;
  return (
    <>
      <Card title="Layout" description={`Format SQL (${displayShortcut('Shift+Alt+F')}) and DDL shown when opening objects.`}>
        <Row label="Keyword case" htmlFor="set-fkw" keywords="uppercase lowercase format">
          <Select id="set-fkw" value={s.format.keywordCase} options={[['upper', 'UPPER'], ['lower', 'lower'], ['asIs', 'As written']]} onChange={(v) => up({ format: { keywordCase: v } })} />
        </Row>
        <Row label="Indent" htmlFor="set-ind" hint="Spaces per level" keywords="indentation format">
          <Num id="set-ind" value={s.format.indent} min={1} max={8} onChange={(v) => up({ format: { indent: v } })} />
        </Row>
        <Row label="Commas" htmlFor="set-comma" keywords="comma leading trailing format">
          <Select id="set-comma" value={s.format.commaStyle} options={[['trailing', 'Trailing (a,)'], ['leading', 'Leading (, a)']]} onChange={(v) => up({ format: { commaStyle: v } })} />
        </Row>
        <Row label="Line width" htmlFor="set-lw" hint="Characters before a line wraps" keywords="wrap width format">
          <Num id="set-lw" value={s.format.lineWidth} min={40} max={400} onChange={(v) => up({ format: { lineWidth: v } })} />
        </Row>
      </Card>
      <Card title="Options">
        <ToggleRow id="set-tabs" label="Indent with tabs" keywords="tabs format" checked={s.format.useTabs} onChange={(v) => up({ format: { useTabs: v } })} />
        <ToggleRow id="set-andor" label="AND / OR on a new line" keywords="and or where format" checked={s.format.andOrOnNewLine} onChange={(v) => up({ format: { andOrOnNewLine: v } })} />
        <ToggleRow id="set-ddl" label="Format DDL when opening an object" keywords="ddl definition format" checked={s.format.formatDdlOnOpen} onChange={(v) => up({ format: { formatDdlOnOpen: v } })} />
      </Card>
    </>
  );
}
