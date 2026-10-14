import { RefreshCw } from 'lucide-react';
import { lazy, Suspense, useEffect, useState, useSyncExternalStore, type ComponentType } from 'react';
import { boot } from './app/boot';
import { handleMenuCommand } from './app/commands';
import { installKeyDispatcher } from './commands/dispatcher';
import { CommandPalette } from './components/CommandPalette/CommandPalette';
import { ConnectionDialogHost } from './components/ConnectionDialog/ConnectionDialog';
import { ConnectionSwitcher } from './components/ConnectionsPanel/ConnectionSwitcher';
import { ConfirmDialog } from './components/common/ConfirmDialog';
import { MenuHost } from './components/common/Menu';
import { Toasts } from './components/common/Toasts';
import { ConsoleView } from './components/layout/ConsoleView';
import { Dock } from './components/layout/Dock';
import { SettingsDialog } from './components/layout/SettingsDialog';
import { TabBar } from './components/layout/TabBar';
import { getTabView, subscribeTabViews } from './components/layout/tabViews';
import { TopBar } from './components/layout/TopBar';
import { MultiRunDialog } from './components/MultiRun/MultiRunDialog';
import { ObjectTabView } from './components/ObjectTab/ObjectTab';
import { Welcome } from './components/Onboarding/Welcome';
import { ShortcutSheet } from './components/Shortcuts/ShortcutSheet';
import { StatusBar } from './components/StatusBar/StatusBar';
import { getPlatform } from './platform';
import { useConnections } from './store/connections';
import { useSettings } from './store/settings';
import { useActiveTab, useTabs, type ViewTab } from './store/tabs';
import { useUi } from './store/ui';
import { useEffectiveTheme, type EffectiveTheme } from './theme/useTheme';

let booted = false;

/** Dev-only IntelliSense playground at /#/playground (lazy: it bundles the fixture catalogs). */
const Playground = import.meta.env.DEV
  ? lazy(async () => {
      const { loadEditorPlayground } = await import('./editor');
      const m = (await loadEditorPlayground()) as Record<string, unknown>;
      return { default: (m.EditorPlayground ?? m.default) as ComponentType };
    })
  : null;

function useHashRoute(): string {
  return useSyncExternalStore(
    (cb) => {
      window.addEventListener('hashchange', cb);
      return () => window.removeEventListener('hashchange', cb);
    },
    () => window.location.hash,
    () => '',
  );
}

export default function App() {
  const hash = useHashRoute();
  if (Playground && hash.startsWith('#/playground')) {
    return (
      <Suspense fallback={<div className="app-loading">Loading playground…</div>}>
        <Playground />
      </Suspense>
    );
  }
  return <Shell />;
}

function Shell() {
  const theme = useEffectiveTheme();
  const [ready, setReady] = useState(booted);

  useEffect(() => {
    // StrictMode mounts effects twice in dev; the module-level flag keeps boot (and its requests) to one run.
    if (booted) {
      setReady(true);
      return;
    }
    booted = true;
    void boot().finally(() => setReady(true));
  }, []);

  useEffect(() => {
    const off = installKeyDispatcher();
    const offMenu = getPlatform().onMenuCommand(handleMenuCommand);
    return () => {
      off();
      offMenu();
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
      <ShortcutSheet />
      <SettingsDialog />
      <ConnectionSwitcher />
      <MultiRunDialog />
      <Toasts />
      <LiveRegion />
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

/** Screen-reader announcements (run completion, errors). */
function LiveRegion() {
  const a = useUi((s) => s.announcement);
  return (
    <div className="sr-only" role="status" aria-live="polite" aria-atomic="true">
      {a ? <span key={a.id}>{a.text}</span> : null}
    </div>
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

function ViewTabHost({ tab, theme, visible }: { tab: ViewTab; theme: EffectiveTheme; visible: boolean }) {
  useSyncExternalStore(subscribeTabViews, () => getTabView(tab.view), () => getTabView(tab.view));
  const def = getTabView(tab.view);
  if (!def) {
    return visible ? (
      <div className="workspace-missing">
        <p>This tab ({tab.view}) is not available in this build.</p>
      </div>
    ) : null;
  }
  const C = def.component;
  return <C tab={tab} theme={theme} visible={visible} />;
}

function Main({ theme, ready }: { theme: EffectiveTheme; ready: boolean }) {
  const tabs = useTabs((s) => s.tabs);
  const activeId = useTabs((s) => s.activeId);

  return (
    <div className="main">
      <Dock />
      <section className="workspace" aria-label="Workspace">
        {tabs.length > 0 && <TabBar />}
        <div className="workspace-body">
          {tabs.length === 0 ? (
            <Welcome ready={ready} />
          ) : (
            tabs.map((t) =>
              t.kind === 'console' ? (
                <ConsoleView key={t.id} tab={t} theme={theme} visible={t.id === activeId} />
              ) : t.kind === 'object' ? (
                <ObjectTabView key={t.id} tab={t} theme={theme} visible={t.id === activeId} />
              ) : (
                <ViewTabHost key={t.id} tab={t} theme={theme} visible={t.id === activeId} />
              ),
            )
          )}
        </div>
      </section>
    </div>
  );
}
