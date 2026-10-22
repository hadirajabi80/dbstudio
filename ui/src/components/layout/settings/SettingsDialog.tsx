// Ctrl+, : Settings (persisted engine-side, shared by Electron and browser modes). One fixed-size dialog for every
// section (nothing jumps when switching to Snippets): a sidebar with search and the sections, and a content pane of
// cards. Typing in the search shows the matching rows of every section at once.
import {
  Braces, Cable, Code, Download, Palette, Search, Settings as SettingsIcon, SlidersHorizontal, Table2, WandSparkles, X,
} from 'lucide-react';
import { lazy, Suspense, useEffect, useLayoutEffect, useRef, useState, type ComponentType, type ReactNode } from 'react';
import { getPlatform } from '../../../platform';
import { useUi } from '../../../store/ui';
import { useUpdates } from '../../../store/updates';
import { Dialog } from '../../common/Dialog';
import { ErrorBoundary } from '../../common/ErrorBoundary';
import { Card, Row } from './controls';
import { useSettingsNav, type SettingsSection } from './nav';
import { matchesQuery, SettingsQuery } from './search';
import { AppearanceSection } from './sections/Appearance';
import { ConnectionsSection } from './sections/Connections';
import { EditorSection } from './sections/Editor';
import { FormattingSection } from './sections/Formatting';
import { GeneralSection } from './sections/General';
import { ResultsSection } from './sections/Results';
import { UpdatesCard } from './UpdatesCard';
import './settings.css';

// WP-H's snippet editor, when present (ui/src/components/SnippetsSettings/*.tsx exporting a component).
const snippetModules = import.meta.glob('../../SnippetsSettings/SnippetsSettings.tsx') as Record<string, () => Promise<Record<string, unknown>>>;
const snippetLoader = Object.values(snippetModules)[0];
const SnippetsSettings = snippetLoader
  ? lazy(async () => {
      const m = await snippetLoader();
      // The store-connected editor: the plain `SnippetsSettings` needs `snippets`/`onChange` props, and rendering it
      // without them crashed the whole window (white page).
      const C = (m.SnippetsSettingsConnected ?? m.default) as ComponentType;
      return { default: C };
    })
  : null;

interface SectionDef {
  id: SettingsSection;
  label: string;
  icon: ReactNode;
  description: string;
  /** Searchable content (absent: Snippets, which is not row-based). */
  render?: () => ReactNode;
}

const SECTIONS: SectionDef[] = [
  { id: 'general', label: 'General', icon: <SlidersHorizontal size={16} />, description: 'Safety and the essentials.', render: () => <GeneralSection /> },
  { id: 'appearance', label: 'Appearance', icon: <Palette size={16} />, description: 'Color theme, code theme, text size and density.', render: () => <AppearanceSection /> },
  { id: 'editor', label: 'Editor', icon: <Code size={16} />, description: 'Writing and running SQL.', render: () => <EditorSection /> },
  { id: 'results', label: 'Results & grid', icon: <Table2 size={16} />, description: 'Result sets, the data tab and editing rows.', render: () => <ResultsSection /> },
  { id: 'format', label: 'SQL formatting', icon: <WandSparkles size={16} />, description: 'How Format SQL lays out your statements.', render: () => <FormattingSection /> },
  { id: 'connections', label: 'Connections', icon: <Cable size={16} />, description: 'Sessions and limits.', render: () => <ConnectionsSection /> },
  ...(SnippetsSettings ? [{ id: 'snippets' as const, label: 'Snippets', icon: <Braces size={16} />, description: 'Your SQL snippets next to the built-in ones.' }] : []),
  { id: 'updates', label: 'Updates', icon: <Download size={16} />, description: 'Your version of Rowlit and new releases.', render: () => <UpdatesCard /> },
];

const SNIPPET_WORDS = 'snippets snippet templates prefix code completion';

/** Ctrl+, : settings (persisted engine-side, shared by Electron and browser modes). */
export function SettingsDialog() {
  const open = useUi((s) => s.settingsOpen);
  if (!open) return null;
  return <Inner />;
}

function Inner() {
  const section = useSettingsNav((s) => s.section);
  const setSection = useSettingsNav((s) => s.setSection);
  const [query, setQuery] = useState('');
  const q = query.trim().toLowerCase();
  const close = () => useUi.getState().setSettingsOpen(false);
  const current = SECTIONS.find((x) => x.id === section) ?? SECTIONS[0];
  const updateState = useUpdates((s) => s.status?.state);
  const updatePending = updateState === 'ready' || updateState === 'available';
  const version = getPlatform().appVersion;

  // While searching: visible rows per section, read back from the rendered rows (always in step with the sections).
  const resultsRef = useRef<HTMLDivElement | null>(null);
  const [counts, setCounts] = useState<Record<string, number>>({});
  useLayoutEffect(() => {
    if (!q) return;
    const next: Record<string, number> = {};
    resultsRef.current?.querySelectorAll<HTMLElement>('[data-settings-section]').forEach((el) => {
      next[el.dataset.settingsSection!] = el.querySelectorAll('[data-settings-row]:not([hidden])').length;
    });
    setCounts((prev) => (JSON.stringify(prev) === JSON.stringify(next) ? prev : next));
  }, [q]);
  const total = Object.values(counts).reduce((a, b) => a + b, 0);

  const go = (id: SettingsSection) => {
    setQuery('');
    setSection(id);
  };
  // the content pane starts at the top of each section
  const scrollRef = useRef<HTMLDivElement | null>(null);
  useEffect(() => {
    scrollRef.current?.scrollTo?.({ top: 0 });
  }, [section, q]);

  return (
    <Dialog title="Settings" ariaLabel="Settings" onClose={close} width={960} className="settings-dialog">
      <div className="settings-shell">
        <aside className="settings-side">
          <div className="settings-side-head">
            <span className="settings-side-icon" aria-hidden="true"><SettingsIcon size={16} /></span>
            <span className="settings-side-title">Settings</span>
          </div>
          <div className="settings-search">
            <Search size={14} aria-hidden="true" />
            <input
              type="search"
              className="settings-search-input"
              placeholder="Search settings"
              aria-label="Search settings"
              value={query}
              onChange={(e) => setQuery(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === 'Escape' && query) {
                  e.stopPropagation();
                  setQuery('');
                }
              }}
            />
            {query && (
              <button type="button" className="settings-search-clear" aria-label="Clear search" onClick={() => setQuery('')}>
                <X size={12} />
              </button>
            )}
          </div>
          <nav className="settings-nav" role="tablist" aria-orientation="vertical" aria-label="Settings sections">
            {SECTIONS.map((x) => {
              const n = q ? (x.render ? counts[x.id] ?? 0 : matchesQuery(q, x.label, SNIPPET_WORDS) ? 1 : 0) : undefined;
              const active = !q && section === x.id;
              return (
                <button
                  key={x.id}
                  type="button"
                  role="tab"
                  aria-selected={active}
                  className={`settings-nav-item${active ? ' active' : ''}${n === 0 ? ' dim' : ''}`}
                  onClick={() => go(x.id)}
                >
                  <span className="settings-nav-icon" aria-hidden="true">{x.icon}</span>
                  <span className="settings-nav-label">{x.label}</span>
                  {n !== undefined && n > 0 && <span className="settings-nav-count" aria-hidden="true">{n}</span>}
                  {n === undefined && x.id === 'updates' && updatePending && <span className="settings-nav-dot" aria-hidden="true" />}
                </button>
              );
            })}
          </nav>
          <div className="settings-side-foot">Rowlit {version}</div>
        </aside>

        <main className="settings-main" role="tabpanel" aria-label={q ? 'Search results' : current.label}>
          <header className="settings-main-head">
            <h2 className="settings-main-title">{q ? 'Search results' : current.label}</h2>
            <p className="settings-main-desc">{q ? (total ? `Settings matching “${query.trim()}”` : `No settings match “${query.trim()}”`) : current.description}</p>
          </header>
          {q ? (
            <div className="settings-scroll" ref={(el) => { scrollRef.current = el; resultsRef.current = el; }}>
              <SettingsQuery.Provider value={q}>
                {SECTIONS.map((x) =>
                  x.render ? (
                    <div key={x.id} className="settings-result-group" data-settings-section={x.id} hidden={counts[x.id] === 0}>
                      <button type="button" className="settings-result-head" onClick={() => go(x.id)}>
                        {x.icon} {x.label}
                      </button>
                      <ErrorBoundary area={`Settings › ${x.label}`} variant="inline">{x.render()}</ErrorBoundary>
                    </div>
                  ) : matchesQuery(q, x.label, SNIPPET_WORDS) ? (
                    <div key={x.id} className="settings-result-group" data-settings-section={x.id}>
                      <Card title={x.label}>
                        <Row label="Your SQL snippets" hint={x.description}>
                          <button type="button" className="btn" onClick={() => go(x.id)}>Open snippets</button>
                        </Row>
                      </Card>
                    </div>
                  ) : null,
                )}
              </SettingsQuery.Provider>
              {!total && (
                <div className="settings-empty">
                  <Search size={28} aria-hidden="true" />
                  <div>Try another word, e.g. “theme”, “font” or “update”.</div>
                </div>
              )}
            </div>
          ) : current.render ? (
            <div className="settings-scroll" ref={scrollRef}>
              {/* Keyed by section: a crashed section shows its error here, the nav and the other sections keep working. */}
              <ErrorBoundary key={current.id} area={`Settings › ${current.label}`} variant="inline">
                {current.render()}
              </ErrorBoundary>
            </div>
          ) : (
            <div className="settings-fill">
              <ErrorBoundary key={current.id} area={`Settings › ${current.label}`} variant="inline">
                {SnippetsSettings && (
                  <Suspense fallback={<div className="muted settings-loading">Loading…</div>}>
                    <SnippetsSettings />
                  </Suspense>
                )}
              </ErrorBoundary>
            </div>
          )}
        </main>
      </div>
    </Dialog>
  );
}
