import { displayShortcut } from '../../../../commands/keys';
import { openRoutinesInEditMode, OPEN_ROUTINES_IN_EDIT_KEY, useSettings, type FullSettings } from '../../../../store/settings';
import { Card, Num, Row, Select, ToggleRow } from '../controls';

export function EditorSection() {
  const s = useSettings((x) => x.settings) as FullSettings;
  const up = useSettings.getState().update;
  return (
    <>
      <Card title="Editing">
        <Row label="Tab size" htmlFor="set-tab" hint="Spaces per indent level" keywords="indent tabs">
          <Num id="set-tab" value={s.editor.tabSize} min={1} max={8} onChange={(v) => up({ editor: { tabSize: v } })} />
        </Row>
      </Card>
      <Card title="IntelliSense" description="How completions are written into your SQL.">
        <Row label="Completion keyword case" htmlFor="set-kw" keywords="uppercase lowercase autocomplete suggest">
          <Select id="set-kw" value={s.editor.keywordCase} options={[['upper', 'UPPER'], ['lower', 'lower'], ['asIs', 'As typed']]} onChange={(v) => up({ editor: { keywordCase: v } })} />
        </Row>
        <Row label="Qualify objects" htmlFor="set-qo" hint="Prefix inserted tables with their schema" keywords="schema prefix autocomplete">
          <Select id="set-qo" value={s.editor.qualifyObjects} options={[['never', 'Never'], ['nonDefaultSchema', 'Outside the default schema'], ['always', 'Always']]} onChange={(v) => up({ editor: { qualifyObjects: v } })} />
        </Row>
      </Card>
      <Card title="Running statements">
        <ToggleRow
          id="set-blank"
          label="A blank line ends a statement"
          hint={`${displayShortcut('Mod+Enter')} runs the paragraph under the cursor`}
          keywords="run execute statement split paragraph"
          checked={s.editor.blankLineSplitsStatements}
          onChange={(v) => up({ editor: { blankLineSplitsStatements: v } })}
        />
      </Card>
      <Card title="Routines">
        <ToggleRow
          id="set-routine-edit"
          label="Open procedures and functions in edit mode"
          hint={`Double-click, Enter and ${displayShortcut('Mod+P')} open them editable; ${displayShortcut('Mod+S')} saves to the database`}
          keywords="routine procedure function alter edit"
          checked={openRoutinesInEditMode(s)}
          onChange={(v) => up({ ui: { [OPEN_ROUTINES_IN_EDIT_KEY]: v } })}
        />
      </Card>
    </>
  );
}
