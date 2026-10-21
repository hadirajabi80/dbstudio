import { RefreshCw } from 'lucide-react';
import { lazy, Suspense, useEffect, useRef, useState, useSyncExternalStore, type ComponentType, type ReactNode } from 'react';
import { boot } from './app/boot';
import { handleMenuCommand } from './app/commands';
import { useUpdateWiring } from './app/updates';
import { windowTitle } from './app/windowTitle';
import { installKeyDispatcher } from './commands/dispatcher';
import { CommandPalette } from './components/CommandPalette/CommandPalette';
import { ConnectionDialogHost } from './components/ConnectionDialog/ConnectionDialog';
import { ConnectionSwitcher } from './components/ConnectionsPanel/ConnectionSwitcher';
import { ConfirmDialog } from './components/common/ConfirmDialog';
import { ErrorBoundary } from './components/common/ErrorBoundary';
import { focusFirst, focusIsLost } from './components/common/focus';
import { MenuHost, useMenu } from './components/common/Menu';
import { Toasts } from './components/common/Toasts';
import { ConsoleView } from './components/layout/ConsoleView';
import { Dock } from './components/layout/Dock';
import { SettingsDialog } from './components/layout/SettingsDialog';
import { TabBar } from './components/layout/TabBar';
import { TopBar } from './components/layout/TopBar';
import { TabErrorBoundary, useFocusFallback, useTabFocusRequests, ViewTabHost } from './components/layout/ViewTabHost';
import './components/layout/layout.css';
import { MultiRunDialog } from './components/MultiRun/MultiRunDialog';
import { ObjectTabView } from './components/ObjectTab/ObjectTab';
import { Welcome } from './components/Onboarding/Welcome';
import { ParamsDialogHost } from './components/ParamsDialog/ParamsDialog';
import { ExecuteRoutineHost } from './components/ExecuteRoutine/ExecuteRoutineDialog';
import { useExecuteRoutine } from './components/ExecuteRoutine/store';
import { ShortcutSheet } from './components/Shortcuts/ShortcutSheet';
import { StatusBar } from './components/StatusBar/StatusBar';
import { DesignerHost } from './designer/host';
import { useDesignerUi } from './designer/store';
import './designer/designer.css';
import { getPlatform } from './platform';
import { useConnections } from './store/connections';
import { useParams } from './store/params';
import { useSettings } from './store/settings';
import { useActiveTab, useTabs } from './store/tabs';
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
  useUpdateWiring();
  useFocusFallback();
  useTabFocusRequests();

  return (
    <div className="app">
      <ErrorBoundary area="the top bar" variant="strip">
        <TopBar theme={theme} />
      </ErrorBoundary>
      <EngineBanner />
      <Main theme={theme} ready={ready} />
      <ErrorBoundary area="the status bar" variant="strip">
        <StatusBar />
      </ErrorBoundary>
      {/* Overlays: each crashes on its own and can be closed from its error panel. */}
      <ErrorBoundary area="the menu" variant="dialog" onClose={() => useMenu.getState().hide()}>
        <MenuHost />
      </ErrorBoundary>
      <ModalBoundary area="the confirmation" open={(s) => !!s.confirm} close={() => useUi.getState().resolveConfirm(false)}>
        <ConfirmDialog />
      </ModalBoundary>
      <div id="dbstudio-designer-host">
        <ErrorBoundary area="the designer dialog" variant="dialog" onClose={() => useDesignerUi.setState({ wizard: null, compareTabId: null })}>
          <DesignerHost />
        </ErrorBoundary>
      </div>
      <div id="params-dialog-host">
        <ErrorBoundary area="the parameters dialog" variant="dialog" onClose={() => useParams.getState().close(null)}>
          <ParamsDialogHost />
        </ErrorBoundary>
      </div>
      <ErrorBoundary area="the execute dialog" variant="dialog" onClose={() => useExecuteRoutine.getState().close()}>
        <ExecuteRoutineHost />
      </ErrorBoundary>
      <ModalBoundary area="the connection dialog" open={(s) => s.connectionDialog} close={() => useUi.getState().closeConnectionDialog()}>
        <ConnectionDialogHost />
      </ModalBoundary>
      <ModalBoundary area="the command palette" open={(s) => s.paletteOpen} close={() => useUi.getState().closePalette()}>
        <CommandPalette />
      </ModalBoundary>
      <ModalBoundary area="the shortcut sheet" open={(s) => s.shortcutsOpen} close={() => useUi.getState().setShortcutsOpen(false)}>
        <ShortcutSheet />
      </ModalBoundary>
      <ModalBoundary area="Settings" open={(s) => s.settingsOpen} close={() => useUi.getState().setSettingsOpen(false)}>
        <SettingsDialog />
      </ModalBoundary>
      <ModalBoundary area="the connection switcher" open={(s) => s.switcher} close={() => useUi.getState().openSwitcher(null)}>
        <ConnectionSwitcher />
      </ModalBoundary>
      <ModalBoundary area="the multi-run dialog" open={(s) => s.multiRunFor} close={() => useUi.getState().openMultiRun(null)}>
        <MultiRunDialog />
      </ModalBoundary>
      <ToastsBoundary>
        <Toasts />
      </ToastsBoundary>
      <LiveRegion />
    </div>
  );
}

type UiState = ReturnType<typeof useUi.getState>;

/**
 * Error boundary of a store-driven modal: its panel is a small dialog whose Close resets the store flag, and reopening
 * the modal (a new flag value) renders it afresh.
 */
function ModalBoundary({ area, open, close, children }: { area: string; open: (s: UiState) => unknown; close: () => void; children: ReactNode }) {
  const key = useUi(open);
  return (
    <ErrorBoundary area={area} variant="dialog" resetKey={key} onClose={close}>
      {children}
    </ErrorBoundary>
  );
}

/** Toasts crash quietly (nothing shown) and come back with the next notification. */
function ToastsBoundary({ children }: { children: ReactNode }) {
  const toasts = useUi((s) => s.toasts);
  return (
    <ErrorBoundary area="notifications" hidden resetKey={toasts}>
      {children}
    </ErrorBoundary>
  );
}

function useWindowTitle() {
  const tab = useActiveTab();
  const conn = useConnections((s) => s.connections.find((c) => c.id === tab?.connectionId));
  useEffect(() => {
    getPlatform().setTitle(windowTitle(tab?.title, conn?.name));
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

function Main({ theme, ready }: { theme: EffectiveTheme; ready: boolean }) {
  const tabs = useTabs((s) => s.tabs);
  const activeId = useTabs((s) => s.activeId);
  const hadTabs = useRef(tabs.length > 0);

  // Closing the last tab: focus the first welcome action instead of leaving focus on <body>.
  useEffect(() => {
    const had = hadTabs.current;
    hadTabs.current = tabs.length > 0;
    if (!had || tabs.length > 0) return;
    const t = setTimeout(() => {
      if (focusIsLost()) focusFirst(document, ['.welcome button:not([disabled])']);
    }, 0);
    return () => clearTimeout(t);
  }, [tabs.length]);

  return (
    <div className="main">
      <Dock />
      <section className="workspace" aria-label="Workspace">
        {tabs.length > 0 && (
          <ErrorBoundary area="the tab strip" variant="strip">
            <TabBar />
          </ErrorBoundary>
        )}
        <div className="workspace-body">
          {tabs.length === 0 ? (
            <ErrorBoundary area="the welcome page" variant="tab">
              <Welcome ready={ready} />
            </ErrorBoundary>
          ) : (
            tabs.map((t) =>
              t.kind === 'console' ? (
                <TabErrorBoundary key={t.id} tab={t} visible={t.id === activeId}>
                  <ConsoleView tab={t} theme={theme} visible={t.id === activeId} />
                </TabErrorBoundary>
              ) : t.kind === 'object' ? (
                <div key={t.id} className="view-tab-host" data-tab-host={t.id} style={{ display: t.id === activeId ? 'contents' : 'none' }}>
                  <TabErrorBoundary tab={t} visible={t.id === activeId}>
                    <ObjectTabView tab={t} theme={theme} visible={t.id === activeId} />
                  </TabErrorBoundary>
                </div>
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
