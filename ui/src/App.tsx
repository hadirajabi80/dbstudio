import { Command, FileClock, Moon, PanelLeft, Plus, RefreshCw, SquareTerminal, Sun, SunMoon } from 'lucide-react';
import { useEffect, useState } from 'react';
import { newConsole } from './app/actions';
import { boot } from './app/boot';
import { handleMenuCommand, onGlobalKeyDown } from './app/commands';
import { CommandPalette } from './components/CommandPalette/CommandPalette';
import { ConnectionDialogHost } from './components/ConnectionDialog/ConnectionDialog';
import { ConfirmDialog } from './components/common/ConfirmDialog';
import { MenuHost } from './components/common/Menu';
import { Splitter } from './components/common/Splitter';
import { Toasts } from './components/common/Toasts';
import { ProviderIcon } from './components/common/icons';
import { Explorer } from './components/Explorer/Explorer';
import { HistoryPanel } from './components/HistoryPanel/HistoryPanel';
import { ConsoleView } from './components/layout/ConsoleView';
import { TabBar } from './components/layout/TabBar';
import { ObjectTabView } from './components/ObjectTab/ObjectTab';
import { StatusBar } from './components/StatusBar/StatusBar';
import { getPlatform } from './platform';
import { useConnections } from './store/connections';
import { useSettings } from './store/settings';
import { useActiveTab, useTabs } from './store/tabs';
import { useUi } from './store/ui';
import { useEffectiveTheme, type EffectiveTheme } from './theme/useTheme';

let booted = false;

export default function App() {
  const theme = useEffectiveTheme();
  const [ready, setReady] = useState(false);

  useEffect(() => {
    if (booted) {
      setReady(true);
      return;
    }
    booted = true;
    void boot().finally(() => setReady(true));
  }, []);

  useEffect(() => {
    window.addEventListener('keydown', onGlobalKeyDown, true);
    const off = getPlatform().onMenuCommand(handleMenuCommand);
    return () => {
      window.removeEventListener('keydown', onGlobalKeyDown, true);
      off();
    };
  }, []);

  useWindowTitle();

  return (
    <div className="app">
      <TopBar theme={theme} />
      <EngineBanner />
      <Main theme={theme} ready={ready} />
      <StatusBar />
      <MenuHost />
      <ConfirmDialog />
      <ConnectionDialogHost />
      <CommandPalette />
      <Toasts />
    </div>
  );
}

function useWindowTitle() {
  const tab = useActiveTab();
  const conn = useConnections((s) => s.connections.find((c) => c.id === tab?.connectionId));
  useEffect(() => {
    const parts = [tab?.title, conn?.name, 'DbStudio'].filter(Boolean);
    getPlatform().setTitle(parts.join(' — '));
  }, [tab?.title, conn?.name]);
}

function TopBar({ theme }: { theme: EffectiveTheme }) {
  const toggle = useUi((s) => s.toggle);
  const explorerVisible = useUi((s) => s.explorerVisible);
  const historyVisible = useUi((s) => s.historyVisible);
  const openPalette = useUi((s) => s.openPalette);
  const openDialog = useUi((s) => s.openConnectionDialog);
  const pref = useSettings((s) => s.settings.theme);
  const update = useSettings((s) => s.update);
  const nextTheme = pref === 'system' ? (theme === 'dark' ? 'light' : 'dark') : pref === 'dark' ? 'light' : 'system';
  const ThemeIcon = pref === 'system' ? SunMoon : theme === 'dark' ? Moon : Sun;
  return (
    <header className="topbar">
      <div className="brand">
        <svg width="18" height="18" viewBox="0 0 32 32" aria-hidden="true">
          <rect width="32" height="32" rx="7" fill="#3574f0" />
          <ellipse cx="16" cy="9.5" rx="8" ry="3.2" fill="#fff" />
          <path d="M8 9.5v13c0 1.8 3.6 3.2 8 3.2s8-1.4 8-3.2v-13M8 16c0 1.8 3.6 3.2 8 3.2s8-1.4 8-3.2" fill="none" stroke="#fff" strokeWidth="2.2" />
        </svg>
        <span>DbStudio</span>
      </div>
      <button className={`icon-btn${explorerVisible ? ' on' : ''}`} title="Toggle explorer (Ctrl+B)" aria-label="Toggle explorer" onClick={() => toggle('explorerVisible')}>
        <PanelLeft size={15} />
      </button>
      <button className="btn btn-ghost" onClick={() => newConsole()} title="New console (Ctrl+T)">
        <SquareTerminal size={14} /> Console
      </button>
      <button className="btn btn-ghost" onClick={() => openDialog({ mode: 'new' })} title="New connection (Ctrl+Shift+N)">
        <Plus size={14} /> Connection
      </button>
      <div className="flex-1" />
      <button className="palette-trigger" onClick={() => openPalette('commands')} title="Command palette (Ctrl+Shift+P)">
        <Command size={13} />
        <span>Search commands and objects</span>
        <kbd>Ctrl+Shift+P</kbd>
      </button>
      <div className="flex-1" />
      <button className={`icon-btn${historyVisible ? ' on' : ''}`} title="Query history (Ctrl+Shift+H)" aria-label="Toggle history" onClick={() => toggle('historyVisible')}>
        <FileClock size={15} />
      </button>
      <button className="icon-btn" title={`Theme: ${pref} (click for ${nextTheme})`} aria-label="Toggle theme" onClick={() => update({ theme: nextTheme })}>
        <ThemeIcon size={15} />
      </button>
    </header>
  );
}

function EngineBanner() {
  const err = useUi((s) => s.engineError);
  if (!err) return null;
  return (
    <div className="engine-banner" role="alert">
      <span>{err}</span>
      <button
        className="btn btn-xs"
        onClick={async () => {
          await useConnections.getState().load();
          const e = useConnections.getState().error;
          useUi.getState().setEngineError(e ? `Cannot reach the DbStudio engine: ${e}` : null);
          if (!e) await useSettings.getState().load();
        }}
      >
        <RefreshCw size={12} /> Retry
      </button>
    </div>
  );
}

function Main({ theme, ready }: { theme: EffectiveTheme; ready: boolean }) {
  const explorerVisible = useUi((s) => s.explorerVisible);
  const historyVisible = useUi((s) => s.historyVisible);
  const explorerWidth = useUi((s) => s.explorerWidth);
  const historyWidth = useUi((s) => s.historyWidth);
  const setLayout = useUi((s) => s.setLayout);
  const tabs = useTabs((s) => s.tabs);
  const activeId = useTabs((s) => s.activeId);
  const [start, setStart] = useState(0);

  return (
    <div className="main">
      {explorerVisible && (
        <>
          <aside className="side-panel" style={{ width: explorerWidth }}>
            <Explorer />
          </aside>
          <Splitter
            direction="vertical"
            ariaLabel="Resize explorer"
            onDragStart={() => setStart(explorerWidth)}
            onDrag={(d) => setLayout({ explorerWidth: Math.max(180, Math.min(700, start + d)) })}
          />
        </>
      )}
      <section className="workspace">
        {tabs.length > 0 && <TabBar />}
        <div className="workspace-body">
          {tabs.length === 0 ? (
            <Welcome ready={ready} />
          ) : (
            tabs.map((t) =>
              t.kind === 'console' ? (
                <ConsoleView key={t.id} tab={t} theme={theme} visible={t.id === activeId} />
              ) : (
                <ObjectTabView key={t.id} tab={t} theme={theme} visible={t.id === activeId} />
              ),
            )
          )}
        </div>
      </section>
      {historyVisible && (
        <>
          <Splitter
            direction="vertical"
            ariaLabel="Resize history"
            onDragStart={() => setStart(historyWidth)}
            onDrag={(d) => setLayout({ historyWidth: Math.max(240, Math.min(800, start - d)) })}
          />
          <aside className="side-panel right" style={{ width: historyWidth }}>
            <HistoryPanel />
          </aside>
        </>
      )}
    </div>
  );
}

function Welcome({ ready }: { ready: boolean }) {
  const connections = useConnections((s) => s.connections);
  const openDialog = useUi((s) => s.openConnectionDialog);
  const recent = [...connections].sort((a, b) => (b.lastUsedAt ?? '').localeCompare(a.lastUsedAt ?? '')).slice(0, 6);
  return (
    <div className="welcome">
      <h1>DbStudio</h1>
      <p className="muted">SQL Server · Oracle · SQLite</p>
      <div className="welcome-actions">
        <button className="btn btn-primary" onClick={() => openDialog({ mode: 'new' })}>
          <Plus size={14} /> New connection
        </button>
        <button className="btn" onClick={() => newConsole()} disabled={!ready}>
          <SquareTerminal size={14} /> New console
        </button>
      </div>
      {recent.length > 0 && (
        <div className="welcome-recent">
          <div className="welcome-section">Open a console on</div>
          {recent.map((c) => (
            <button key={c.id} className="welcome-conn" onClick={() => newConsole(c.id, null)}>
              <ProviderIcon providerId={c.providerId} color={c.color} size={16} />
              <span>{c.name}</span>
              {c.folder && <span className="muted">{c.folder}</span>}
            </button>
          ))}
        </div>
      )}
      <div className="welcome-keys">
        <span><kbd>Ctrl</kbd>+<kbd>Shift</kbd>+<kbd>P</kbd> commands</span>
        <span><kbd>Ctrl</kbd>+<kbd>P</kbd> go to object</span>
        <span><kbd>Ctrl</kbd>+<kbd>T</kbd> new console</span>
        <span><kbd>Ctrl</kbd>+<kbd>Enter</kbd> run statement</span>
      </div>
    </div>
  );
}
