// ER diagram tab (docs/PLAN-M2.md section 3): toolbar (scope, add tables, search, column mode, types, filters, layout,
// fit, export), the canvas with minimap, the details pane and a status line. The diagram is built from the catalog
// store only (CatalogObject c / pk / fk), loading the schemas its scope needs.
import { ChevronDown, Download, LoaderCircle, PanelRight, Search, TriangleAlert, Waypoints, X } from 'lucide-react';
import { useEffect, useMemo, useRef, useState } from 'react';
import { useStore } from 'zustand';
import { layoutScopeKey } from '../../api/er';
import type { DiagramScope } from '../../api/types';
import { preloadCatalog } from '../../app/actions';
import { runCommand } from '../../commands/registry';
import { useCommandContext } from '../../commands/useCommands';
import { dbKey, useCatalog } from '../../store/catalog';
import { useConnection, useDialect } from '../../store/connections';
import { useTabs } from '../../store/tabs';
import { showMenuBelow } from '../common/Menu';
import { Select } from '../common/Select';
import { CommandButton } from '../layout/CommandButton';
import { commandMenuItems } from '../layout/commandMenu';
import type { TabViewProps } from '../layout/tabViews';
import { AddTablesDialog } from './AddTablesDialog';
import { ER_VIEW_ID, fkUnavailableReason, registerController } from './controllers';
import { DetailsPane } from './DetailsPane';
import { ErCanvas } from './ErCanvas';
import { FkDialog } from './fkDialog';
import { ER_LAYOUT_MENU } from './menus';
import { oneHopSchemas, relationshipSummary, schemasOfScope } from './model';
import { diagramTitle } from './open';
import { ErController, type ErTabState, type ViewOptions } from './store';
import { syntheticSchemas } from './synthetic';
import './er.css';

const TABLES_SCOPE = '\u0000tables';

const LAYOUT_LABEL = { 'layered-lr': 'Layered →', 'layered-tb': 'Layered ↓', grid: 'Grid' } as const;

export function ErDiagramView({ tab, visible }: TabViewProps) {
  const initial = tab.state as ErTabState;
  const [c] = useState(() => new ErController(tab.id, initial));
  useEffect(() => registerController(tab.id, c), [c, tab.id]);
  useEffect(() => {
    c.attach();
    return () => c.dispose();
  }, [c]);
  useCommandContext();

  const cid = initial.connectionId;
  const database = initial.database;
  const synthetic = initial.synthetic ?? null;
  const scope = useStore(c.store, (s) => s.scope);
  const added = useStore(c.store, (s) => s.added);
  const phase = useStore(c.store, (s) => s.phase);
  const progress = useStore(c.store, (s) => s.progress);
  const error = useStore(c.store, (s) => s.error);
  const options = useStore(c.store, (s) => s.options);
  const model = useStore(c.store, (s) => s.model);
  const selection = useStore(c.store, (s) => s.selection);
  const focusKey = useStore(c.store, (s) => s.focusKey);
  const search = useStore(c.store, (s) => s.search);
  const searchHit = useStore(c.store, (s) => s.searchHit);
  const save = useStore(c.store, (s) => s.save);
  const saveError = useStore(c.store, (s) => s.saveError);
  const auto = useStore(c.store, (s) => s.auto);
  const addOpen = useStore(c.store, (s) => s.addOpen);
  const fkDraft = useStore(c.store, (s) => s.fkDraft);
  const conn = useConnection(synthetic ? null : cid);
  const dialect = useDialect(cid);

  // ---- catalog
  const db = useCatalog((s) => (synthetic ? undefined : s.dbs[dbKey(cid, database)]));
  const needed = useMemo(() => schemasOfScope(scope, added), [scope, added]);
  const synth = useMemo(() => (synthetic ? syntheticSchemas(synthetic) : null), [synthetic]);

  useEffect(() => {
    if (synthetic) return;
    let cancelled = false;
    void (async () => {
      await preloadCatalog(cid, database);
      if (cancelled) return;
      const cat = useCatalog.getState();
      await cat.loadSchemas(cid, database);
      for (const s of needed) void useCatalog.getState().loadSchema(cid, database, s);
    })();
    return () => {
      cancelled = true;
    };
  }, [cid, database, needed, synthetic]);

  const snapshot = db?.snapshot ?? null;
  useEffect(() => {
    if (synth) c.setCatalog(synth, 'main');
    else if (snapshot) c.setCatalog(snapshot.schemas, snapshot.defaultSchema);
  }, [c, synth, snapshot]);

  // One FK hop: the schemas the scope's tables reference and the schemas referencing them (engine `refBy`), so
  // cross-schema keys in both directions are drawn with real cards (old databases spread tables over owner schemas).
  const settled = (s: string) => db?.schemaStatus[s] === 'ready' || db?.schemaStatus[s] === 'error';
  const neededReady = !!snapshot && needed.every(settled);
  const hop = useMemo(() => (synthetic || !neededReady || !snapshot ? [] : oneHopSchemas(snapshot.schemas, needed)), [synthetic, neededReady, snapshot, needed]);
  const hopKey = hop.join('\u0000');
  useEffect(() => {
    if (!hopKey) return;
    for (const s of hopKey.split('\u0000')) void useCatalog.getState().loadSchema(cid, database, s);
  }, [cid, database, hopKey]);

  const catalogReady = !!synth || (neededReady && hop.every(settled));
  const catalogError = needed.map((s) => db?.schemaError[s]).find(Boolean) ?? (db?.schemasError || null);
  const hopErrors = hop.filter((s) => db?.schemaStatus[s] === 'error');
  useEffect(() => {
    if (catalogReady && phase === 'loading') void c.start();
  }, [c, catalogReady, phase]);

  // ---- search box
  const searchRef = useRef<HTMLInputElement>(null);
  useEffect(() => {
    c.focusSearchDom = () => {
      searchRef.current?.focus();
      searchRef.current?.select();
    };
    return () => {
      c.focusSearchDom = null;
    };
  }, [c]);
  const matches = useMemo(() => (search.trim() && model ? c.matches(search) : []), [c, search, model]);

  // ---- scope switch
  const schemaNames = useMemo(() => {
    const names = db?.schemasResp?.schemas.map((s) => s.name) ?? (synth ? synth.map((s) => s.name) : Object.keys(db?.loaded ?? {}));
    return scope.schema && !names.includes(scope.schema) ? [scope.schema, ...names] : names;
  }, [db, synth, scope.schema]);
  const changeSchema = (v: string) => {
    if (v === TABLES_SCOPE || v === scope.schema) return;
    const next: DiagramScope = { database, schema: v };
    c.setScope(next);
    const st: ErTabState = { ...initial, scope: next };
    useTabs.getState().updateView(tab.id, { state: st, title: diagramTitle(st), key: `${cid}:${ER_VIEW_ID}:${layoutScopeKey(next)}` });
  };

  const fkReason = fkUnavailableReason(cid, !!synthetic);
  const setOpt = <K extends keyof ViewOptions>(k: K, v: ViewOptions[K]) => c.setOption(k, v);
  const members = useMemo(() => new Set(model?.nodes.filter((n) => !n.ghost).map((n) => n.key) ?? []), [model]);
  const selected = selection.length === 1 ? model?.byKey.get(selection[0]) : focusKey && !selection.length ? model?.byKey.get(focusKey) : undefined;
  const summary = useMemo(() => (model ? relationshipSummary(model) : null), [model]);
  const saveText = synthetic ? 'generated (not saved)' : save === 'saving' ? 'saving layout…' : save === 'pending' ? 'unsaved changes' : save === 'saved' ? 'layout saved' : save === 'error' ? 'layout not saved' : 'auto layout';

  return (
    <div className="er" data-command-scope="er" style={{ display: visible ? undefined : 'none' }}>
      <div className="er-toolbar" role="toolbar" aria-label="ER diagram">
        <div className="er-tb-group">
          <Waypoints size={15} className="er-tb-icon" aria-hidden="true" />
          <Select
            aria-label="Diagram scope"
            size="sm"
            mono
            value={scope.schema ?? TABLES_SCOPE}
            onChange={changeSchema}
            disabled={!!synthetic}
            options={[
              ...(scope.tables?.length ? [{ value: TABLES_SCOPE, label: `${scope.tables.length} selected tables` }] : []),
              ...schemaNames.map((s) => ({ value: s, label: s })),
            ]}
            style={{ minWidth: 120, maxWidth: 220 }}
          />
          <CommandButton command="er.addTables" variant="btn" className="btn-xs" label="Add tables…" />
        </div>
        <div className="er-tb-group er-search" role="search">
          <Search size={13} aria-hidden="true" className="er-search-icon" />
          <input
            ref={searchRef}
            className="input xs er-search-input"
            placeholder="Find table or column"
            aria-label="Find table or column"
            value={search}
            onChange={(e) => c.setSearch(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Enter') {
                e.preventDefault();
                c.searchStep(e.shiftKey ? -1 : 1);
              } else if (e.key === 'Escape') {
                e.preventDefault();
                e.stopPropagation();
                c.setSearch('');
                const k = c.state.focusKey;
                if (k) c.focusDom?.(k);
              }
            }}
          />
          {search && (
            <>
              <span className="er-search-count" aria-live="polite">{matches.length ? `${Math.min(searchHit + 1, matches.length)}/${matches.length}` : 'none'}</span>
              <button type="button" className="icon-btn xs" aria-label="Clear search" onClick={() => c.setSearch('')}><X size={12} /></button>
            </>
          )}
        </div>
        <div className="er-tb-group">
          <Select
            aria-label="Columns shown"
            size="sm"
            value={options.columns}
            onChange={(v) => setOpt('columns', v)}
            options={[{ value: 'all', label: 'All columns' }, { value: 'keys', label: 'Keys only' }, { value: 'none', label: 'Names only' }]}
          />
          <label className="check sm er-check"><input type="checkbox" checked={options.types} onChange={(e) => setOpt('types', e.target.checked)} /> Types</label>
          <label className="check sm er-check"><input type="checkbox" checked={options.onlyConnected} onChange={(e) => setOpt('onlyConnected', e.target.checked)} /> Only related</label>
          <label className="check sm er-check"><input type="checkbox" checked={options.hideViews} onChange={(e) => setOpt('hideViews', e.target.checked)} /> Hide views</label>
        </div>
        <div className="er-tb-group er-tb-end">
          <button
            type="button"
            className="btn btn-xs"
            aria-haspopup="menu"
            title="Auto layout"
            disabled={phase !== 'ready'}
            onClick={(e) => showMenuBelow(e.currentTarget, commandMenuItems(ER_LAYOUT_MENU))}
          >
            Layout: {LAYOUT_LABEL[auto]} <ChevronDown size={11} aria-hidden="true" />
          </button>
          <CommandButton command="er.fit" variant="btn" className="btn-xs" label="Fit" />
          <span className="rs-sep" aria-hidden="true" />
          <button type="button" className="btn btn-xs" title="Export the whole diagram as PNG" disabled={phase !== 'ready'} onClick={() => runCommand('er.exportPng')}><Download size={12} aria-hidden="true" /> PNG</button>
          <button type="button" className="btn btn-xs" title="Export the whole diagram as SVG" disabled={phase !== 'ready'} onClick={() => runCommand('er.exportSvg')}><Download size={12} aria-hidden="true" /> SVG</button>
          <button
            type="button"
            className={`icon-btn sm${options.details ? ' on' : ''}`}
            aria-pressed={options.details}
            aria-label="Details pane"
            title="Toggle the details pane"
            onClick={() => runCommand('er.toggleDetails')}
          >
            <PanelRight size={15} />
          </button>
        </div>
      </div>
      <div className="er-main">
        <div className="er-stage">
          <ErCanvas c={c} tabId={tab.id} visible={visible} label={tab.title} fkEnabled={!fkReason} fkReason={fkReason} />
          {(phase === 'loading' || phase === 'layout') && !catalogError && (
            <div className="er-overlay" role="status">
              <LoaderCircle size={18} className="spin" aria-hidden="true" />
              <span>{phase === 'layout' ? progress ?? 'Laying out…' : `Loading ${scope.schema ?? 'tables'}…`}</span>
            </div>
          )}
          {(phase === 'error' || catalogError) && (
            <div className="er-overlay er-overlay-error" role="alert">
              <span>{error ?? catalogError}</span>
              <button type="button" className="btn btn-xs" onClick={() => (catalogError ? void useCatalog.getState().refresh(cid, database) : void c.relayout())}>Retry</button>
            </div>
          )}
          {phase === 'ready' && model && model.memberCount === 0 && (
            <div className="er-empty">
              <Waypoints size={28} aria-hidden="true" />
              <div className="er-empty-title">{scope.schema ? `No tables in ${scope.schema}` : 'No tables in this diagram'}</div>
              <div className="muted">Add tables from any schema of this database.</div>
              <CommandButton command="er.addTables" variant="primary" label="Add tables…" />
            </div>
          )}
        </div>
        {options.details && <DetailsPane c={c} tabId={tab.id} />}
      </div>
      <div className="er-status" role="status" aria-live="polite">
        <span title={summary?.title ?? undefined} data-testid="er-summary">{summary ? summary.text : '…'}</span>
        {summary?.warn && (
          <span className="er-status-warn" title={summary.title ?? undefined}>
            <TriangleAlert size={12} aria-hidden="true" /> Some relationships are not visible to this login
          </span>
        )}
        {hopErrors.length > 0 && (
          <span className="er-status-warn" title={hopErrors.map((s) => `${s}: ${db?.schemaError[s] ?? 'failed'}`).join('\n')}>
            <TriangleAlert size={12} aria-hidden="true" /> Could not load {hopErrors.join(', ')}
          </span>
        )}
        <span className={`er-status-save ${save}`} title={saveError ?? undefined}>{saveText}</span>
        {conn && <span className="er-status-conn">{conn.name}{conn.readOnly ? ' · read-only' : ''}</span>}
        <span className="flex-1" />
        <span className="er-status-sel">{selection.length > 1 ? `${selection.length} selected` : selected ? `selected: ${selected.label}` : ''}</span>
        <span className="er-status-hint">Drag to pan · wheel zooms · Shift+drag selects</span>
      </div>
      {addOpen && (
        <AddTablesDialog
          connectionId={cid}
          database={database}
          initialSchema={scope.schema ?? needed[0] ?? null}
          members={members}
          onAdd={(keys) => c.add(keys)}
          onClose={() => c.setAddOpen(false)}
        />
      )}
      {fkDraft && model && !fkReason && (
        <FkDialog draft={fkDraft} model={model} connectionId={cid} database={database} dialect={dialect} onClose={() => c.setFkDraft(null)} />
      )}
    </div>
  );
}
