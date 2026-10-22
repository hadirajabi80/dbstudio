// The DbStudio SQL editor: Monaco + the intel engine (completion, signature help, hover, F12, soft and server
// diagnostics) with SSMS/DataGrip run keybindings. Implements the frozen SqlEditor.types.ts contract.
//
// Multi-instance safety: every keybinding is a per-editor action (addAction), global Monaco registrations happen
// once (ensureMonacoSetup), and providers find this editor's intel through the model URI (registry.ts).
import { forwardRef, useEffect, useImperativeHandle, useRef } from 'react';
import * as monaco from './monaco';
import type { ExplainMode, RunLabel, ServerDiagnostic } from '../api/types';
import { createIntel, type Intel } from '../intel';
import { intelOptionsFromSettings } from './settings';
import type { RunTargetOptions, SqlEditorHandle, SqlEditorProps } from './SqlEditor.types';
import { ensureMonacoSetup, LANGUAGE_IDS, THEME_IDS } from './monaco-setup';
import { baseMonacoOptions, remeasureAfterFonts, suggestMetrics } from './monacoOptions';
import { bindEditorFontSize, editorFontSize } from './fontZoom';
import { refreshSuggest, triggerSuggest } from './suggestKey';
import { bindModel, setActiveBinding, type ModelBinding } from './registry';
import { dismissEditorPopups, formatDocument, formatSelection, openSnippetPicker, runExplain } from './actions';
import { getEditorConfig } from './config';
import { guardEditorSuggest } from './suggest-guard';
import { paramHintText, statementParams } from './param-hint';
import { snippetSource } from '../snippets';
import { postfixSource } from '../intel/complete/postfix';
import { displayShortcut, isAltGraphCharacter, isMac } from '../commands/keys';
import { resolveRunTarget } from './run-target';
import { LatestRequest, MARKER_OWNERS, serverMarkers, softMarkers, type MarkerSeverities } from './markers-core';

export type { SqlEditorHandle, SqlEditorProps } from './SqlEditor.types';

const SEV: MarkerSeverities = { error: monaco.MarkerSeverity.Error, warning: monaco.MarkerSeverity.Warning, info: monaco.MarkerSeverity.Info };

/** Esc cancels a running query only when no editor widget wants the key. */
const ESC_PRECONDITION = '!suggestWidgetVisible && !parameterHintsVisible && !findWidgetVisible && !inSnippetMode && !hasMultipleSelections && !renameInputVisible && !referenceSearchVisible && !markersNavigationVisible && !hasNonEmptySelection';


function modelUriFor(tabId: string): monaco.Uri {
  return monaco.Uri.parse(`dbstudio-tab://tab/${encodeURIComponent(tabId)}.sql`);
}

export const SqlEditor = forwardRef<SqlEditorHandle, SqlEditorProps>(function SqlEditor(props, ref) {
  const host = useRef<HTMLDivElement>(null);
  const edRef = useRef<monaco.editor.IStandaloneCodeEditor | null>(null);
  const intelRef = useRef<Intel | null>(null);
  const propsRef = useRef(props);
  propsRef.current = props;
  const uriRef = useRef<string>('');
  const externalEdit = useRef(false);
  const lastUsage = useRef<Record<string, number> | undefined>(undefined);
  const serverReq = useRef(new LatestRequest<ServerDiagnostic[]>(400));
  const softTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const flashIds = useRef<monaco.editor.IEditorDecorationsCollection | null>(null);
  const bindingRef = useRef<ModelBinding | null>(null);
  const hintIds = useRef<monaco.editor.IEditorDecorationsCollection | null>(null);
  const hintTimer = useRef<ReturnType<typeof setTimeout> | null>(null);

  // ------------------------------------------------------------ helpers (stable through refs)

  const refreshSoft = () => {
    const ed = edRef.current, intel = intelRef.current, model = ed?.getModel();
    if (!ed || !intel || !model) return;
    monaco.editor.setModelMarkers(model, MARKER_OWNERS.soft, softMarkers(intel.softDiagnostics(uriRef.current), SEV));
  };
  const scheduleDiagnostics = () => {
    if (softTimer.current) clearTimeout(softTimer.current);
    softTimer.current = setTimeout(refreshSoft, 250);
    const req = propsRef.current.requestServerDiagnostics;
    const model = edRef.current?.getModel();
    if (!req || !model) return;
    const version = model.getVersionId();
    serverReq.current.schedule(
      () => req(model.getValue()),
      (diags) => {
        if (model.isDisposed() || model.getVersionId() !== version) return;
        monaco.editor.setModelMarkers(model, MARKER_OWNERS.server, serverMarkers(diags, SEV, 'server', (line, col) => {
          const w = model.getWordAtPosition({ lineNumber: line, column: col });
          return w ? w.endColumn : null;
        }));
      },
    );
  };

  const runTarget = (label: RunLabel, opts?: RunTargetOptions) => {
    const ed = edRef.current, intel = intelRef.current, model = ed?.getModel();
    if (!ed || !intel || !model) return null;
    const sel = ed.getSelection();
    const pos = ed.getPosition();
    const cursor = pos ? model.getOffsetAt(pos) : 0;
    const selection: [number, number] | null = sel && !sel.isEmpty() ? [model.getOffsetAt(sel.getStartPosition()), model.getOffsetAt(sel.getEndPosition())] : null;
    return resolveRunTarget(intel, uriRef.current, label, cursor, selection, opts);
  };

  const flash = (range: [number, number]) => {
    const ed = edRef.current, model = ed?.getModel();
    if (!ed || !model) return;
    const a = model.getPositionAt(range[0]), z = model.getPositionAt(range[1]);
    flashIds.current?.clear();
    flashIds.current = ed.createDecorationsCollection([{ range: new monaco.Range(a.lineNumber, a.column, z.lineNumber, z.column), options: { className: 'dbstudio-run-flash', isWholeLine: false } }]);
    const coll = flashIds.current;
    setTimeout(() => { if (flashIds.current === coll) { coll.clear(); flashIds.current = null; } }, 650);
  };

  const fmtOptions = () => propsRef.current.formatOptions ?? getEditorConfig().format;
  const doFormat = (selectionOnly: boolean) => {
    const ed = edRef.current;
    if (!ed) return 0;
    return (selectionOnly ? formatSelection : formatDocument)(ed, propsRef.current.dialect, fmtOptions()).length;
  };
  const doExplain = (mode: ExplainMode) => {
    const ed = edRef.current;
    if (!ed) return false;
    const onExplain = propsRef.current.onExplain;
    return runExplain(ed, bindingRef.current ?? undefined, mode, onExplain ? (t) => onExplain(t.mode, t.batch) : null);
  };

  /** "2 parameters · Ctrl+Alt+P to edit" after the first line of the statement at the cursor. */
  const refreshParamHint = () => {
    const ed = edRef.current, intel = intelRef.current, model = ed?.getModel();
    if (!ed || !intel || !model) return;
    hintIds.current ??= ed.createDecorationsCollection();
    const pos = ed.getPosition();
    const st = pos && propsRef.current.parameterHint !== false ? intel.statementAt(uriRef.current, model.getOffsetAt(pos)) : null;
    if (!st || st.skipOnRun) { hintIds.current.clear(); return; }
    const toks = intel.tokens(uriRef.current);
    let a = 0;
    while (a < toks.length && toks[a].start < st.start) a++;
    let b = a;
    while (b < toks.length && toks[b].end <= st.end && toks[b].kind !== 'eof') b++;
    let batch: typeof toks | undefined;
    if (propsRef.current.dialect === 'tsql') {
      const sameBatch = intel.statements(uriRef.current).filter((x) => x.batchIndex === st.batchIndex);
      const from = sameBatch[0]?.start ?? st.start, to = sameBatch[sameBatch.length - 1]?.end ?? st.end;
      batch = toks.filter((t) => t.start >= from && t.end <= to);
    }
    const params = statementParams(toks, a, b, propsRef.current.dialect, batch);
    if (!params.length) { hintIds.current.clear(); return; }
    const line = st.line;
    hintIds.current.set([{
      range: new monaco.Range(line, model.getLineMaxColumn(line), line, model.getLineMaxColumn(line)),
      options: { after: { content: '  ' + paramHintText(params.length, displayShortcut('Ctrl+Alt+P')), inlineClassName: 'dbstudio-param-hint' }, showIfCollapsed: true },
    }]);
  };
  const scheduleParamHint = () => {
    if (hintTimer.current) clearTimeout(hintTimer.current);
    hintTimer.current = setTimeout(refreshParamHint, 150);
  };

  const run = (label: RunLabel) => {
    const t = runTarget(label);
    if (!t) return;
    flash(t.range);
    if (!t.batches.length) return;
    if (edRef.current) dismissEditorPopups(edRef.current);
    propsRef.current.onRun(t.label, t.batches);
  };

  useImperativeHandle(ref, () => ({
    focus: () => edRef.current?.focus(),
    getRunTarget: (label: RunLabel, opts?: RunTargetOptions) => {
      const t = runTarget(label, opts);
      // Every caller takes the statement away from the editor (run from the toolbar or Ctrl+Enter in a console,
      // multi-run, code, parameters): close the suggest list and parameter hints first (styles-r1-05).
      if (t && edRef.current) dismissEditorPopups(edRef.current);
      return t ? { batches: t.batches, text: t.text, label: t.label } : null;
    },
    insertText: (text: string) => {
      const ed = edRef.current;
      const sel = ed?.getSelection();
      if (!ed || !sel) return;
      ed.executeEdits('dbstudio.insertText', [{ range: sel, text, forceMoveMarkers: true }]);
      ed.pushUndoStop();
      ed.focus();
    },
    revealLine: (line: number, col = 1) => {
      const ed = edRef.current;
      if (!ed) return;
      ed.revealLineInCenterIfOutsideViewport(line);
      ed.setPosition({ lineNumber: line, column: col });
      ed.focus();
    },
    selectRange: (line: number, col: number, endLine: number, endCol: number) => {
      const ed = edRef.current;
      if (!ed) return;
      ed.revealRangeInCenterIfOutsideViewport({ startLineNumber: line, startColumn: col, endLineNumber: endLine, endColumn: endCol });
      ed.setSelection({ startLineNumber: line, startColumn: col, endLineNumber: endLine, endColumn: endCol });
      ed.focus();
    },
    getValue: () => edRef.current?.getModel()?.getValue() ?? propsRef.current.value,
    formatDocument: () => doFormat(false),
    formatSelection: () => doFormat(true),
    openSnippetPicker: () => { if (edRef.current) openSnippetPicker(edRef.current, bindingRef.current ?? undefined); },
    triggerSuggest: () => { if (edRef.current) triggerSuggest(edRef.current); },
    explain: (mode: ExplainMode) => doExplain(mode),
  }), []);

  // ------------------------------------------------------------ mount / dialect change

  useEffect(() => {
    if (!host.current) return;
    ensureMonacoSetup();
    const p = propsRef.current;
    const dialect = p.dialect;
    const intel = createIntel(dialect, intelOptionsFromSettings(p.settings, dialect));
    intel.setCatalog(p.catalog);
    intel.setUsage(p.usage);
    lastUsage.current = p.usage;
    intelRef.current = intel;
    const uri = modelUriFor(p.tabId);
    uriRef.current = uri.toString();
    monaco.editor.getModel(uri)?.dispose();
    const model = monaco.editor.createModel(p.value, LANGUAGE_IDS[dialect], uri);
    model.updateOptions({ tabSize: p.settings?.tabSize ?? 4, insertSpaces: true });
    intel.setDocument(uriRef.current, model.getValue());
    if (p.resolvePublicSynonym) intel.setPublicSynonymResolver((n) => propsRef.current.resolvePublicSynonym?.(n) ?? Promise.resolve(null));
    intel.setSchemaRequester((s) => propsRef.current.requestSchema?.(s));
    intel.setExtraCompletionSources([snippetSource(dialect, () => propsRef.current.snippets ?? getEditorConfig().snippets), postfixSource]);

    const ed = monaco.editor.create(host.current, {
      ...baseMonacoOptions(),
      model,
      theme: p.theme === 'dark' ? THEME_IDS.dark : THEME_IDS.light,
      readOnly: !!p.readOnly,
      // Settings.editor.fontSize, followed live and changed with Ctrl + wheel (bindEditorFontSize below)
      fontSize: editorFontSize(),
      ...suggestMetrics(editorFontSize()),
      fontLigatures: false,
      automaticLayout: true,
      minimap: { enabled: false },
      scrollBeyondLastLine: false,
      fixedOverflowWidgets: true,
      renderLineHighlight: 'line',
      lineNumbersMinChars: 3,
      quickSuggestions: { other: true, comments: false, strings: false },
      quickSuggestionsDelay: 0,
      suggestOnTriggerCharacters: true,
      wordBasedSuggestions: 'off',
      acceptSuggestionOnCommitCharacter: false,
      tabCompletion: 'on',
      snippetSuggestions: 'inline',
      suggest: { showWords: false, snippetsPreventQuickSuggestions: false, localityBonus: false, shareSuggestSelections: false, showStatusBar: false, preview: false, filterGraceful: true, insertMode: 'replace' },
      parameterHints: { enabled: true, cycle: true },
      hover: { enabled: 'on', delay: 350 },
      guides: { indentation: true },
      'semanticHighlighting.enabled': false,
      unicodeHighlight: { ambiguousCharacters: false },
      stickyScroll: { enabled: false },
    });
    edRef.current = ed;
    const unbindFont = bindEditorFontSize(ed);
    guardEditorSuggest(ed);
    remeasureAfterFonts();

    const binding: ModelBinding = {
      uri: uriRef.current,
      intel,
      editor: ed,
      connectionId: () => propsRef.current.catalog?.connectionId ?? '',
      database: () => propsRef.current.catalog?.database ?? null,
      openObject: (r) => propsRef.current.onOpenObject?.(r),
      accepted: (usageKey) => {
        intel.recordAccepted({ usageKey });
        const u = intel.getUsage();
        lastUsage.current = u;
        propsRef.current.onUsageChange?.(u);
      },
      dialect,
      tabId: p.tabId,
      formatOptions: fmtOptions,
      snippets: () => propsRef.current.snippets ?? getEditorConfig().snippets,
    };
    bindingRef.current = binding;
    const unbind = bindModel(binding);

    const subs: monaco.IDisposable[] = [];
    subs.push(model.onDidChangeContent((e) => {
      if (e.changes.length === 1) {
        const c = e.changes[0];
        intel.applyEdit(uriRef.current, { rangeOffset: c.rangeOffset, rangeLength: c.rangeLength, text: c.text });
      } else {
        intel.setDocument(uriRef.current, model.getValue());
      }
      if (!externalEdit.current) propsRef.current.onChange(model.getValue());
      scheduleDiagnostics();    }));
    subs.push(ed.onDidChangeCursorPosition((e) => { propsRef.current.onCursorChange?.(e.position.lineNumber, e.position.column); scheduleParamHint(); }));
    subs.push(ed.onDidFocusEditorText(() => setActiveBinding(binding.uri)));
    subs.push(model.onDidChangeContent(() => scheduleParamHint()));
    subs.push({ dispose: intel.onDidChange(() => scheduleDiagnostics()) });

    // per-editor actions (never addCommand: that binds to the last created editor)
    const K = monaco.KeyMod, C = monaco.KeyCode;
    subs.push(ed.addAction({
      id: 'dbstudio.runStatement', label: 'Run Statement at Cursor (or Selection)', keybindings: [K.CtrlCmd | C.Enter],
      contextMenuGroupId: 'navigation', contextMenuOrder: 0,
      run: () => run('statement'),
    }));
    subs.push(ed.addAction({ id: 'dbstudio.runScript', label: 'Run Script (or Selection)', keybindings: [C.F5, K.CtrlCmd | K.Shift | C.Enter], contextMenuGroupId: 'navigation', contextMenuOrder: 1, run: () => run('script') }));
    subs.push(ed.addAction({ id: 'dbstudio.cancel', label: 'Cancel Running Query', keybindings: [C.Escape], precondition: ESC_PRECONDITION, run: () => propsRef.current.onCancel?.() }));
    subs.push(ed.addAction({ id: 'dbstudio.duplicateLine', label: 'Duplicate Line', keybindings: [K.CtrlCmd | C.KeyD], run: (x) => x.trigger('dbstudio', 'editor.action.copyLinesDownAction', {}) }));
    subs.push(ed.addAction({ id: 'dbstudio.upperCase', label: 'Transform to Upper Case', keybindings: [K.CtrlCmd | K.Shift | C.KeyU], run: (x) => x.trigger('dbstudio', 'editor.action.transformToUppercase', {}) }));
    // Ctrl+Shift+L is Explain (actual) in M1.5 (PLAN-M1.5 section 3 reserved shortcuts); lower case keeps its palette entry
    subs.push(ed.addAction({ id: 'dbstudio.lowerCase', label: 'Transform to Lower Case', run: (x) => x.trigger('dbstudio', 'editor.action.transformToLowercase', {}) }));
    // M1.5 (WP-H): formatter, snippets, explain. KeyMod.CtrlCmd = Ctrl on Windows/Linux, Cmd on macOS.
    // Format Document (Shift+Alt+F, context menu) is Monaco's built-in command over the DbStudio formatting
    // provider (monaco-setup.ts); a second custom action would list the same command twice.
    // Ctrl+Alt+L (⌘⌥L, DataGrip's "Reformat code", user-01) runs the same command. Inside a console the registry's
    // format.document gets the key first (capture phase); this covers the other editors (designers, wizards). A key
    // handler rather than a Monaco keybinding, so AltGr+L ("ł" on Polish keyboards) still types its character.
    subs.push(ed.onKeyDown((e) => {
      const be = e.browserEvent;
      if (e.keyCode !== C.KeyL || !(isMac() ? be.metaKey : be.ctrlKey) || !be.altKey || be.shiftKey || isAltGraphCharacter(be)) return;
      if (ed.getRawOptions().readOnly) return;
      e.preventDefault();
      e.stopPropagation();
      void ed.getAction('editor.action.formatDocument')?.run();
    }));
    subs.push(ed.addAction({
      id: 'dbstudio.formatSelection', label: 'Format SQL (Selection or Statement)', keybindings: [K.chord(K.CtrlCmd | C.KeyK, K.CtrlCmd | C.KeyF)],
      contextMenuGroupId: '1_modification', contextMenuOrder: 2, precondition: '!editorReadonly', run: () => { doFormat(true); },
    }));
    subs.push(ed.addAction({
      id: 'dbstudio.insertSnippet', label: 'Insert Snippet…', keybindings: [K.CtrlCmd | C.KeyJ],
      contextMenuGroupId: '1_modification', contextMenuOrder: 3, precondition: '!editorReadonly',
      run: (x) => openSnippetPicker(x as monaco.editor.IStandaloneCodeEditor, bindingRef.current ?? undefined),
    }));
    subs.push(ed.addAction({
      id: 'dbstudio.explainEstimated', label: 'Explain Plan (Estimated)', keybindings: [K.CtrlCmd | C.KeyL],
      contextMenuGroupId: 'navigation', contextMenuOrder: 2, run: () => { doExplain('estimated'); },
    }));
    subs.push(ed.addAction({
      id: 'dbstudio.explainActual', label: 'Explain Plan (Actual, runs the statement)', keybindings: [K.CtrlCmd | K.Shift | C.KeyL],
      contextMenuGroupId: 'navigation', contextMenuOrder: 3, run: () => { doExplain('actual'); },
    }));
    // Ctrl+Space / Ctrl+I (⌃Space / ⌘I): replaces Monaco's binding, which does nothing while the widget shows its
    // 'No suggestions.' / 'Loading…' message (editor/suggestKey.ts). Registered after Monaco's, so it wins.
    subs.push(ed.addAction({
      id: 'dbstudio.triggerSuggest', label: 'Trigger Suggest', keybindings: [(isMac() ? K.WinCtrl : K.CtrlCmd) | C.Space, K.CtrlCmd | C.KeyI],
      contextMenuGroupId: '1_modification', contextMenuOrder: 1, precondition: '!editorReadonly', run: (x) => { triggerSuggest(x); },
    }));
    subs.push(ed.addAction({ id: 'dbstudio.signatureHelp', label: 'Parameter Info', keybindings: [K.CtrlCmd | K.Shift | C.Space], run: (x) => x.trigger('dbstudio', 'editor.action.triggerParameterHints', {}) }));

    refreshSoft();
    scheduleDiagnostics();
    scheduleParamHint();

    return () => {
      if (hintTimer.current) clearTimeout(hintTimer.current);
      hintIds.current = null;
      bindingRef.current = null;
      serverReq.current.cancel();
      if (softTimer.current) clearTimeout(softTimer.current);
      for (const s of subs) s.dispose();
      unbind();
      unbindFont();
      ed.dispose();
      model.dispose();
      edRef.current = null;
      intelRef.current = null;
    };
    // remount when the tab identity or dialect changes
  }, [props.tabId, props.dialect]);

  // ------------------------------------------------------------ prop sync

  useEffect(() => {
    const ed = edRef.current, model = ed?.getModel();
    if (!ed || !model || model.getValue() === props.value) return;
    externalEdit.current = true;
    try {
      model.pushEditOperations(ed.getSelections() ?? [], [{ range: model.getFullModelRange(), text: props.value }], () => null);
    } finally {
      externalEdit.current = false;
    }
  }, [props.value]);

  useEffect(() => {
    intelRef.current?.setCatalog(props.catalog);
    refreshSoft();
    // a "Loading <schema>…" row is on screen: show the schema's objects now that the catalog has them
    const b = bindingRef.current, ed = edRef.current;
    if (b?.suggestLoading && ed) {
      b.suggestLoading = false;
      refreshSuggest(ed);
    }
  }, [props.catalog]);

  useEffect(() => {
    monaco.editor.setTheme(props.theme === 'dark' ? THEME_IDS.dark : THEME_IDS.light);
  }, [props.theme]);

  useEffect(() => {
    const ed = edRef.current;
    ed?.updateOptions({ readOnly: !!props.readOnly });
  }, [props.readOnly]);

  useEffect(() => {
    const ed = edRef.current;
    const s = props.settings;
    if (!ed || !s) return;
    ed.getModel()?.updateOptions({ tabSize: s.tabSize });
    intelRef.current?.setOptions(intelOptionsFromSettings(s, props.dialect));
    refreshSoft();
  }, [props.settings, props.dialect]);

  useEffect(() => {
    if (props.usage !== lastUsage.current) {
      intelRef.current?.setUsage(props.usage);
      lastUsage.current = props.usage;
    }
  }, [props.usage]);

  useEffect(() => {
    const intel = intelRef.current;
    if (!intel) return;
    intel.setPublicSynonymResolver(props.resolvePublicSynonym ? (n) => propsRef.current.resolvePublicSynonym?.(n) ?? Promise.resolve(null) : null);
  }, [props.resolvePublicSynonym]);

  useEffect(() => {
    const model = edRef.current?.getModel();
    if (!model) return;
    monaco.editor.setModelMarkers(model, MARKER_OWNERS.external, serverMarkers(props.externalDiagnostics ?? [], SEV, 'execution', (line, col) => {
      if (line < 1 || line > model.getLineCount()) return null;
      const w = model.getWordAtPosition({ lineNumber: line, column: col });
      return w ? w.endColumn : null;
    }));
  }, [props.externalDiagnostics]);

  useEffect(() => {
    if (!props.requestServerDiagnostics) {
      serverReq.current.cancel();
      const model = edRef.current?.getModel();
      if (model) monaco.editor.setModelMarkers(model, MARKER_OWNERS.server, []);
    } else scheduleDiagnostics();
  }, [props.requestServerDiagnostics]);

  return <div ref={host} className="dbstudio-sql-editor" style={{ width: '100%', height: '100%', minHeight: 0 }} />;
});

export default SqlEditor;
