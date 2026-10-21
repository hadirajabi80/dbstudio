import { Settings as SettingsIcon } from 'lucide-react';
import { lazy, Suspense, useState, type ComponentType, type ReactNode } from 'react';
import { displayShortcut } from '../../commands/keys';
import { getPlatform } from '../../platform';
import { AUTO_CHECK_UPDATES_KEY, autoCheckUpdates, useSettings, type FullSettings } from '../../store/settings';
import { useUi } from '../../store/ui';
import { Dialog } from '../common/Dialog';
import { Select as StyledSelect } from '../common/Select';

// WP-H's snippet editor, when present (ui/src/components/SnippetsSettings/*.tsx exporting a component).
const snippetModules = import.meta.glob('../SnippetsSettings/SnippetsSettings.tsx') as Record<string, () => Promise<Record<string, unknown>>>;
const snippetLoader = Object.values(snippetModules)[0];
const SnippetsSettings = snippetLoader
  ? lazy(async () => {
      const m = await snippetLoader();
      const C = (m.SnippetsSettings ?? m.default ?? Object.values(m).find((v) => typeof v === 'function')) as ComponentType;
      return { default: C };
    })
  : null;

type Section = 'general' | 'editor' | 'results' | 'format' | 'connections' | 'snippets';
const SECTIONS: { id: Section; label: string }[] = [
  { id: 'general', label: 'General' },
  { id: 'editor', label: 'Editor' },
  { id: 'results', label: 'Results & grid' },
  { id: 'format', label: 'SQL formatting' },
  { id: 'connections', label: 'Connections' },
  ...(SnippetsSettings ? [{ id: 'snippets' as Section, label: 'Snippets' }] : []),
];

function Row({ label, htmlFor, hint, children }: { label: string; htmlFor?: string; hint?: string; children: ReactNode }) {
  return (
    <div className="settings-row">
      <label className="settings-label" htmlFor={htmlFor}>
        {label}
        {hint && <span className="settings-hint">{hint}</span>}
      </label>
      <div className="settings-control">{children}</div>
    </div>
  );
}

function Select<T extends string>({ id, value, options, onChange }: { id: string; value: T; options: [T, string][]; onChange: (v: T) => void }) {
  return <StyledSelect id={id} value={value} options={options.map(([v, l]) => ({ value: v, label: l }))} onChange={onChange} />;
}

function Num({ id, value, min, max, onChange }: { id: string; value: number; min: number; max: number; onChange: (v: number) => void }) {
  return (
    <input
      id={id}
      type="number"
      className="input narrow"
      value={value}
      min={min}
      max={max}
      onChange={(e) => {
        const n = Number(e.target.value);
        if (Number.isFinite(n) && n >= min && n <= max) onChange(n);
      }}
    />
  );
}

function Check({ id, checked, onChange, children }: { id: string; checked: boolean; onChange: (v: boolean) => void; children: ReactNode }) {
  return (
    <label className="check" htmlFor={id}>
      <input id={id} type="checkbox" checked={checked} onChange={(e) => onChange(e.target.checked)} />
      {children}
    </label>
  );
}

/** Ctrl+, : settings (persisted engine-side, shared by Electron and browser modes). */
export function SettingsDialog() {
  const open = useUi((s) => s.settingsOpen);
  if (!open) return null;
  return <Inner />;
}

function Inner() {
  const s = useSettings((x) => x.settings) as FullSettings;
  const up = useSettings.getState().update;
  const [section, setSection] = useState<Section>('general');
  const close = () => useUi.getState().setSettingsOpen(false);
  // Desktop builds only: the browser build has no updater.
  const updatesAvailable = typeof getPlatform().checkForUpdates === 'function';

  return (
    <Dialog title={<span className="dialog-title-icon"><SettingsIcon size={16} /> Settings</span>} ariaLabel="Settings" onClose={close} width={760} className="settings-dialog">
      <div className="settings-layout">
        <nav className="settings-nav" role="tablist" aria-orientation="vertical" aria-label="Settings sections">
          {SECTIONS.map((x) => (
            <button key={x.id} role="tab" aria-selected={section === x.id} className={`settings-nav-item${section === x.id ? ' active' : ''}`} onClick={() => setSection(x.id)}>
              {x.label}
            </button>
          ))}
        </nav>
        <div className="settings-body" role="tabpanel">
          {section === 'general' && (
            <>
              <Row label="Theme" htmlFor="set-theme" hint="System follows Windows / macOS">
                <Select id="set-theme" value={s.theme} options={[['system', 'Follow system'], ['light', 'Light'], ['dark', 'Dark']]} onChange={(v) => up({ theme: v })} />
              </Row>
              <Row label="Density" htmlFor="set-density" hint="Grid row height 28 / 24 px">
                <Select id="set-density" value={s.grid.density} options={[['comfortable', 'Comfortable'], ['compact', 'Compact']]} onChange={(v) => up({ grid: { density: v } })} />
              </Row>
              <Row label="Safety">
                <Check id="set-confirm" checked={s.confirmDestructive} onChange={(v) => up({ confirmDestructive: v })}>
                  Confirm statements that modify data (UPDATE/DELETE without WHERE, DROP, TRUNCATE…)
                </Check>
              </Row>
              {updatesAvailable && (
                <Row label="Updates" hint={`DbStudio ${getPlatform().appVersion}`}>
                  <Check id="set-updates" checked={autoCheckUpdates(s)} onChange={(v) => up({ ui: { [AUTO_CHECK_UPDATES_KEY]: v } })}>
                    Automatically check for updates
                  </Check>
                </Row>
              )}
            </>
          )}
          {section === 'editor' && (
            <>
              <Row label="Font size" htmlFor="set-fs"><Num id="set-fs" value={s.editor.fontSize} min={9} max={32} onChange={(v) => up({ editor: { fontSize: v } })} /></Row>
              <Row label="Tab size" htmlFor="set-tab"><Num id="set-tab" value={s.editor.tabSize} min={1} max={8} onChange={(v) => up({ editor: { tabSize: v } })} /></Row>
              <Row label="Completion keyword case" htmlFor="set-kw">
                <Select id="set-kw" value={s.editor.keywordCase} options={[['upper', 'UPPER'], ['lower', 'lower'], ['asIs', 'As typed']]} onChange={(v) => up({ editor: { keywordCase: v } })} />
              </Row>
              <Row label="Qualify objects" htmlFor="set-qo">
                <Select id="set-qo" value={s.editor.qualifyObjects} options={[['never', 'Never'], ['nonDefaultSchema', 'Outside the default schema'], ['always', 'Always']]} onChange={(v) => up({ editor: { qualifyObjects: v } })} />
              </Row>
              <Row label="Statements">
                <Check id="set-blank" checked={s.editor.blankLineSplitsStatements} onChange={(v) => up({ editor: { blankLineSplitsStatements: v } })}>
                  A blank line ends a statement ({displayShortcut('Mod+Enter')} runs the paragraph under the cursor)
                </Check>
              </Row>
            </>
          )}
          {section === 'results' && (
            <>
              <Row label="Default row limit" htmlFor="set-max" hint="0 = no limit"><Num id="set-max" value={s.results.maxRows} min={0} max={10_000_000} onChange={(v) => up({ results: { maxRows: v } })} /></Row>
              <Row label="NULL shown as" htmlFor="set-null">
                <input id="set-null" className="input narrow" value={s.results.nullText} onChange={(e) => up({ results: { nullText: e.target.value } })} />
              </Row>
              <Row label="Dates" htmlFor="set-date">
                <Select id="set-date" value={s.results.dateFormat} options={[['iso', 'ISO 8601'], ['locale', 'System locale']]} onChange={(v) => up({ results: { dateFormat: v } })} />
              </Row>
              <Row label="Data tab page size" htmlFor="set-page"><Num id="set-page" value={s.grid.pageSize} min={50} max={100000} onChange={(v) => up({ grid: { pageSize: v } })} /></Row>
              <Row label="Data editing">
                <Check id="set-verify" checked={s.grid.verifyUnchanged} onChange={(v) => up({ grid: { verifyUnchanged: v } })}>
                  Verify unchanged values when saving edits (optimistic concurrency)
                </Check>
                <Check id="set-showsql" checked={!!s.grid.showSqlBeforeSave} onChange={(v) => up({ grid: { showSqlBeforeSave: v } })}>
                  Show the SQL before saving edits (off: {displayShortcut('Mod+S')} saves directly)
                </Check>
              </Row>
            </>
          )}
          {section === 'format' && (
            <>
              <Row label="Keyword case" htmlFor="set-fkw">
                <Select id="set-fkw" value={s.format.keywordCase} options={[['upper', 'UPPER'], ['lower', 'lower'], ['asIs', 'As written']]} onChange={(v) => up({ format: { keywordCase: v } })} />
              </Row>
              <Row label="Indent" htmlFor="set-ind"><Num id="set-ind" value={s.format.indent} min={1} max={8} onChange={(v) => up({ format: { indent: v } })} /></Row>
              <Row label="Commas" htmlFor="set-comma">
                <Select id="set-comma" value={s.format.commaStyle} options={[['trailing', 'Trailing (a,)'], ['leading', 'Leading (, a)']]} onChange={(v) => up({ format: { commaStyle: v } })} />
              </Row>
              <Row label="Line width" htmlFor="set-lw"><Num id="set-lw" value={s.format.lineWidth} min={40} max={400} onChange={(v) => up({ format: { lineWidth: v } })} /></Row>
              <Row label="Options">
                <Check id="set-tabs" checked={s.format.useTabs} onChange={(v) => up({ format: { useTabs: v } })}>Indent with tabs</Check>
                <Check id="set-andor" checked={s.format.andOrOnNewLine} onChange={(v) => up({ format: { andOrOnNewLine: v } })}>AND / OR on a new line</Check>
                <Check id="set-ddl" checked={s.format.formatDdlOnOpen} onChange={(v) => up({ format: { formatDdlOnOpen: v } })}>Format DDL when opening an object</Check>
              </Row>
            </>
          )}
          {section === 'connections' && (
            <Row label="Sessions per connection" htmlFor="set-sess" hint="The engine refuses more (SESSION_LIMIT)">
              <Num id="set-sess" value={s.connections.maxSessionsPerProfile} min={1} max={64} onChange={(v) => up({ connections: { maxSessionsPerProfile: v } })} />
            </Row>
          )}
          {section === 'snippets' && SnippetsSettings && (
            <Suspense fallback={<div className="muted">Loading…</div>}>
              <SnippetsSettings />
            </Suspense>
          )}
        </div>
      </div>
    </Dialog>
  );
}
