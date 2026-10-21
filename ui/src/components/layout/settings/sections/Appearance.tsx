import { Monitor, Moon, Sun } from 'lucide-react';
import { isMac } from '../../../../commands/keys';
import { useSettings, type FullSettings } from '../../../../store/settings';
import { Card, Num, Row, Segmented, Select } from '../controls';
import { AppThemePicker, EditorThemePicker } from '../ThemePicker';

export function AppearanceSection() {
  const s = useSettings((x) => x.settings) as FullSettings;
  const up = useSettings.getState().update;
  return (
    <>
      <Card title="Color theme" description="The look of the whole window: panels, menus, dialogs, the grid and the title bar.">
        <Row label="Mode" hint={`System follows ${isMac() ? 'macOS' : 'Windows'} between your light and dark theme`} keywords="theme dark light system appearance">
          <Segmented
            label="Mode"
            value={s.theme}
            onChange={(v) => up({ theme: v })}
            options={[
              { value: 'system', label: 'System', icon: <Monitor size={14} /> },
              { value: 'light', label: 'Light', icon: <Sun size={14} /> },
              { value: 'dark', label: 'Dark', icon: <Moon size={14} /> },
            ]}
          />
        </Row>
        <Row label="Theme" stacked labelHidden keywords="color colour theme palette nord midnight violet paper solarized">
          <AppThemePicker />
        </Row>
      </Card>
      <Card title="Code theme" description="Syntax colours of the SQL editor and every other code view.">
        <Row label="Code theme" stacked labelHidden keywords="code editor syntax highlighting monaco theme github dracula monokai one dark solarized">
          <EditorThemePicker />
        </Row>
      </Card>
      <Card title="Text & density">
        <Row label="Editor font size" htmlFor="set-fs" hint={`Every SQL editor; ${isMac() ? '⌘' : 'Ctrl'} + mouse wheel over an editor changes it too`} keywords="font text size zoom">
          <Num id="set-fs" value={s.editor.fontSize} min={9} max={32} onChange={(v) => up({ editor: { fontSize: v } })} />
        </Row>
        <Row label="Density" htmlFor="set-density" hint="Grid row height 28 / 24 px" keywords="compact comfortable rows">
          <Select id="set-density" value={s.grid.density} options={[['comfortable', 'Comfortable'], ['compact', 'Compact']]} onChange={(v) => up({ grid: { density: v } })} />
        </Row>
      </Card>
    </>
  );
}
