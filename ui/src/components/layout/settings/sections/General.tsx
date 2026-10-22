import { Keyboard } from 'lucide-react';
import { displayShortcut } from '../../../../commands/keys';
import { runCommand } from '../../../../commands/registry';
import { OBJECTS_TAB_SETTING, showObjectsTab, useSettings, type FullSettings } from '../../../../store/settings';
import { useUi } from '../../../../store/ui';
import { Card, Row, ToggleRow } from '../controls';

export function GeneralSection() {
  const s = useSettings((x) => x.settings) as FullSettings;
  const up = useSettings.getState().update;
  return (
    <>
      <Card title="Safety" description="Guard rails for statements that change data.">
        <ToggleRow
          id="set-confirm"
          label="Confirm statements that modify data"
          hint="UPDATE / DELETE without WHERE, DROP, TRUNCATE…"
          keywords="destructive safety confirm warning"
          checked={s.confirmDestructive}
          onChange={(v) => up({ confirmDestructive: v })}
        />
      </Card>
      <Card title="Workspace">
        <ToggleRow
          id="set-objects-tab"
          label="Show the Objects tab"
          hint="A permanent first tab that lists the tables, views and routines of what is selected in the explorer"
          keywords="objects tab navicat home start page pinned explorer selection tables procedures"
          checked={showObjectsTab(s)}
          onChange={(v) => up({ ui: { [OBJECTS_TAB_SETTING]: v } })}
        />
      </Card>
      <Card title="Keyboard">
        <Row label="Keyboard shortcuts" hint={`Every command and its keys (${displayShortcut('F1')})`} keywords="keys bindings hotkeys">
          <button
            type="button"
            className="btn"
            onClick={() => {
              useUi.getState().setSettingsOpen(false);
              runCommand('view.shortcuts');
            }}
          >
            <Keyboard size={16} /> Show shortcuts
          </button>
        </Row>
      </Card>
    </>
  );
}
