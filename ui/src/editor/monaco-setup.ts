// One-time global Monaco setup: worker, the four Rowlit SQL languages, lexer-driven tokens, themes and the
// language feature providers. Providers resolve per-model state through the registry (multi-editor safe).
// Colours (themes, run flash) come from the design tokens in ui/src/theme, never from literals here.
import * as monaco from './monaco';
import EditorWorker from 'monaco-editor/editor/editor.worker?worker';
import type { Dialect } from '../api/types';
import { getSpec, type CompletionItem, type CompletionKind, type LexState } from '../intel';
import { tokenizeLine } from './tokens-core';
import { bindingByUri, bindingFor, bindingForEditor } from './registry';
import { objectUri, parseObjectUri, objectSummary } from './object-uri';
import { formatRange, formatSql, type FormatWarning } from '../format';
import { snippetPickerItems } from '../snippets';
import { getEditorConfig } from './config';
import { FORMAT_MARKER_OWNER } from './actions';
import { defineMonacoThemes } from '../theme/monacoTheme';
import { followUpPayload } from './suggestKey';

export const LANGUAGE_IDS: Record<Dialect, string> = {
  tsql: 'dbstudio-tsql',
  plsql: 'dbstudio-plsql',
  sqlite: 'dbstudio-sqlite',
  pgsql: 'dbstudio-pgsql',
};

const LANGUAGE_ALIASES: Record<Dialect, string> = { tsql: 'T-SQL', plsql: 'PL/SQL', sqlite: 'SQLite', pgsql: 'PostgreSQL' };

export const THEME_IDS = { light: 'dbstudio-light', dark: 'dbstudio-dark' } as const;

export const TRIGGER_CHARACTERS = ['.', '(', ',', '@', ':', '#', '[', '"', ' '];

/** A space only opens the popup after these keywords (DataGrip style: `FROM `, `JOIN `, `ON ` ...). */
const SPACE_TRIGGER_AFTER = /(^|[\s(,])(FROM|JOIN|UPDATE|INTO|EXEC|EXECUTE|CALL|ON|USING|APPLY|LATERAL|RETURNING|CONFLICT)\s$/i;

// Kept on globalThis so Vite HMR re-evaluating this module does not register providers twice.
const SETUP_KEY = '__dbstudioMonacoSetup';

class LineState implements monaco.languages.IState {
  readonly s: LexState;
  constructor(s: LexState) { this.s = s; }
  clone(): LineState { return new LineState(this.s); }
  equals(other: monaco.languages.IState): boolean { return other instanceof LineState && other.s === this.s; }
}

const KIND: Record<CompletionKind, monaco.languages.CompletionItemKind> = {
  table: monaco.languages.CompletionItemKind.Struct,
  view: monaco.languages.CompletionItemKind.Interface,
  column: monaco.languages.CompletionItemKind.Field,
  alias: monaco.languages.CompletionItemKind.Reference,
  schema: monaco.languages.CompletionItemKind.Module,
  database: monaco.languages.CompletionItemKind.Folder,
  cte: monaco.languages.CompletionItemKind.Class,
  function: monaco.languages.CompletionItemKind.Function,
  procedure: monaco.languages.CompletionItemKind.Method,
  package: monaco.languages.CompletionItemKind.Module,
  keyword: monaco.languages.CompletionItemKind.Keyword,
  snippet: monaco.languages.CompletionItemKind.Snippet,
  variable: monaco.languages.CompletionItemKind.Variable,
  parameter: monaco.languages.CompletionItemKind.TypeParameter,
  sequence: monaco.languages.CompletionItemKind.Constant,
  synonym: monaco.languages.CompletionItemKind.EnumMember,
  type: monaco.languages.CompletionItemKind.TypeParameter,
  operator: monaco.languages.CompletionItemKind.Operator,
};

const ACCEPT_COMMAND = 'dbstudio.completionAccepted';

function installStyles(): void {
  if (typeof document === 'undefined' || document.getElementById('dbstudio-editor-styles')) return;
  const st = document.createElement('style');
  st.id = 'dbstudio-editor-styles';
  st.textContent = `
.dbstudio-run-flash { background: var(--run-flash); transition: background 0.4s ease-out; }
.dbstudio-run-flash-off { background: transparent; transition: background 0.5s ease-out; }
.dbstudio-param-hint { color: var(--fg-muted, currentColor); opacity: 0.8; font-style: italic; }
`;
  document.head.appendChild(st);
}

/** Both Rowlit themes, built from the design tokens (theme/monacoTheme.ts) before the first editor paints. */
function defineThemes(): void {
  defineMonacoThemes(monaco.editor, THEME_IDS);
}

function registerLanguage(dialect: Dialect): void {
  const id = LANGUAGE_IDS[dialect];
  const spec = getSpec(dialect);
  monaco.languages.register({ id, extensions: [], aliases: [LANGUAGE_ALIASES[dialect]] });
  const brackets: monaco.languages.CharacterPair[] = [['(', ')']];
  const autoClosing: monaco.languages.IAutoClosingPairConditional[] = [
    { open: '(', close: ')' },
    { open: "'", close: "'", notIn: ['string', 'comment'] },
    { open: '"', close: '"', notIn: ['string', 'comment'] },
  ];
  if (dialect === 'tsql') autoClosing.push({ open: '[', close: ']', notIn: ['string', 'comment'] });
  if (dialect === 'sqlite') autoClosing.push({ open: '`', close: '`', notIn: ['string', 'comment'] });
  monaco.languages.setLanguageConfiguration(id, {
    comments: { lineComment: '--', blockComment: ['/*', '*/'] },
    brackets,
    autoClosingPairs: autoClosing,
    surroundingPairs: [{ open: '(', close: ')' }, { open: "'", close: "'" }, { open: '"', close: '"' }, ...(dialect === 'tsql' ? [{ open: '[', close: ']' }] : [])],
    // words include T-SQL @vars / #temp, Oracle $ and # identifier characters
    wordPattern: dialect === 'tsql' ? /(@@?|##?)?[\p{L}_][\p{L}\p{N}_$#@]*/u : dialect === 'plsql' ? /:?[\p{L}_][\p{L}\p{N}_$#]*/u : /[\p{L}_][\p{L}\p{N}_$]*/u,
    indentationRules: {
      increaseIndentPattern: /^\s*(BEGIN|CASE|LOOP|THEN|ELSE|DECLARE|IS|AS)\b(?!.*\bEND\b).*$/i,
      decreaseIndentPattern: /^\s*(END|ELSE|ELSIF|EXCEPTION|WHEN)\b/i,
    },
  });
  monaco.languages.setTokensProvider(id, {
    getInitialState: () => new LineState(''),
    tokenize: (line: string, state: monaco.languages.IState) => {
      const s = state instanceof LineState ? state.s : '';
      const r = tokenizeLine(line, spec, s);
      return { tokens: r.tokens, endState: new LineState(r.endState) };
    },
  });

  monaco.languages.registerCompletionItemProvider(id, {
    triggerCharacters: TRIGGER_CHARACTERS,
    provideCompletionItems(model, position, context) {
      const b = bindingFor(model);
      if (!b) return { suggestions: [] };
      if (context.triggerCharacter === ' ') {
        const before = model.getLineContent(position.lineNumber).slice(0, position.column - 1);
        if (!SPACE_TRIGGER_AFTER.test(before)) return { suggestions: [] };
      }
      const offset = model.getOffsetAt(position);
      if (b.snippetPicker) {
        // Ctrl+J "Insert snippet…": snippets only, anywhere
        b.snippetPicker = false;
        const w = model.getWordUntilPosition(position);
        const from = offset - (position.column - w.startColumn);
        const insert = new monaco.Range(position.lineNumber, w.startColumn, position.lineNumber, position.column);
        const items = snippetPickerItems(dialect, b.snippets?.() ?? getEditorConfig().snippets, w.word, [from, offset]);
        return { suggestions: items.map((it) => toSuggestion(it, model, b.uri, w.word, false, insert, insert)), incomplete: false };
      }
      const res = b.intel.complete(b.uri, offset, context.triggerCharacter);
      const start = model.getPositionAt(Math.min(res.replaceRange[0], offset));
      const startPos = start.lineNumber === position.lineNumber ? start : new monaco.Position(position.lineNumber, 1);
      const word = model.getWordAtPosition(position);
      const endCol = word && word.endColumn > position.column ? word.endColumn : position.column;
      const insert = new monaco.Range(startPos.lineNumber, startPos.column, position.lineNumber, position.column);
      const replace = new monaco.Range(startPos.lineNumber, startPos.column, position.lineNumber, endCol);
      const typed = model.getValueInRange(insert);
      const typedHasSpace = /\s/.test(typed);
      const suggestions = res.items.map((it) => toSuggestion(it, model, b.uri, typed, typedHasSpace, insert, replace));
      b.suggestLoading = res.items.some((it) => it.loading);
      return { suggestions, incomplete: !!res.isIncomplete || b.suggestLoading };
    },
  });

  // Formatting (WP-H). "Format Document" (Shift+Alt+F, editor context menu) is Monaco's own command running this
  // provider: Monaco diffs the result into minimal edits, so the cursor stays put, and the statements the formatter
  // left verbatim are flagged with the same markers as the toolbar/palette path (actions.formatDocument).
  // "Format SQL (Selection or Statement)" (Ctrl+K Ctrl+F) stays a SqlEditor action: it also formats the statement
  // at the cursor when nothing is selected.
  const fmtOptions = (model: monaco.editor.ITextModel) => bindingFor(model)?.formatOptions?.() ?? getEditorConfig().format;
  monaco.languages.registerDocumentFormattingEditProvider(id, {
    displayName: 'Rowlit SQL formatter',
    provideDocumentFormattingEdits(model) {
      const text = model.getValue();
      const r = formatSql(text, dialect, fmtOptions(model));
      // warning lines refer to the formatted text: mark them once Monaco has applied the edits
      const mark = () => { if (!model.isDisposed()) monaco.editor.setModelMarkers(model, FORMAT_MARKER_OWNER, formatWarningMarkers(model, r.warnings)); };
      monaco.editor.setModelMarkers(model, FORMAT_MARKER_OWNER, []);
      if (r.text === text) {
        mark();
        return [];
      }
      const sub = model.onDidChangeContent(() => {
        if (model.getValue() !== r.text) return;
        sub.dispose();
        mark();
      });
      setTimeout(() => sub.dispose(), 2000); // edits dropped (stale request, cancelled): never mark later typing
      return [{ range: model.getFullModelRange(), text: r.text }];
    },
  });
  monaco.languages.registerDocumentRangeFormattingEditProvider(id, {
    displayName: 'Rowlit SQL formatter',
    provideDocumentRangeFormattingEdits(model, range) {
      const r = formatRange(model.getValue(), dialect, [model.getOffsetAt(range.getStartPosition()), model.getOffsetAt(range.getEndPosition())], fmtOptions(model));
      if (!r) return [];
      const a = model.getPositionAt(r.range[0]), z = model.getPositionAt(r.range[1]);
      const rng = new monaco.Range(a.lineNumber, a.column, z.lineNumber, z.column);
      return model.getValueInRange(rng) === r.text ? [] : [{ range: rng, text: r.text }];
    },
  });

  monaco.languages.registerSignatureHelpProvider(id, {
    signatureHelpTriggerCharacters: ['(', ','],
    signatureHelpRetriggerCharacters: [','],
    provideSignatureHelp(model, position) {
      const b = bindingFor(model);
      if (!b) return null;
      const sh = b.intel.signatureHelp(b.uri, model.getOffsetAt(position));
      if (!sh) return null;
      return {
        value: {
          signatures: sh.signatures.map((s) => ({
            label: s.label,
            documentation: s.documentation ? { value: s.documentation } : undefined,
            parameters: s.parameters.map((p) => ({ label: p.label, documentation: p.documentation })),
          })),
          activeSignature: sh.activeSignature,
          activeParameter: sh.activeParameter,
        },
        dispose() {},
      };
    },
  });

  monaco.languages.registerHoverProvider(id, {
    provideHover(model, position) {
      const b = bindingFor(model);
      if (!b) return null;
      const h = b.intel.hover(b.uri, model.getOffsetAt(position));
      if (!h) return null;
      const a = model.getPositionAt(h.range[0]), z = model.getPositionAt(h.range[1]);
      return { range: new monaco.Range(a.lineNumber, a.column, z.lineNumber, z.column), contents: [{ value: h.markdown, isTrusted: false }] };
    },
  });

  monaco.languages.registerDefinitionProvider(id, {
    provideDefinition(model, position) {
      const b = bindingFor(model);
      if (!b) return null;
      const d = b.intel.definition(b.uri, model.getOffsetAt(position));
      if (!d) return null;
      if (d.kind === 'local') {
        const a = model.getPositionAt(d.range[0]), z = model.getPositionAt(d.range[1]);
        return { uri: model.uri, range: new monaco.Range(a.lineNumber, a.column, z.lineNumber, z.column) };
      }
      const uri = monaco.Uri.parse(objectUri(b.connectionId(), d.ref, d.column, b.uri));
      // a tiny read-only model so Ctrl+hover can preview the object; the opener routes the navigation to the app
      if (!monaco.editor.getModel(uri)) monaco.editor.createModel(objectSummary(d.ref, b), id, uri);
      return { uri, range: new monaco.Range(1, 1, 1, 1) };
    },
  });
}

/** Same markers as actions.formatDocument: one warning per statement the formatter left verbatim. */
function formatWarningMarkers(model: monaco.editor.ITextModel, warnings: FormatWarning[]): monaco.editor.IMarkerData[] {
  return warnings.map((w) => {
    const line = Math.min(Math.max(1, w.line), model.getLineCount());
    return {
      severity: monaco.MarkerSeverity.Warning, message: w.message, source: 'formatter', code: 'FORMAT_SKIPPED',
      startLineNumber: line, startColumn: 1, endLineNumber: line, endColumn: model.getLineMaxColumn(line),
    };
  });
}

function toSuggestion(
  it: CompletionItem, model: monaco.editor.ITextModel, uri: string, typed: string, typedHasSpace: boolean,
  insert: monaco.Range, replace: monaco.Range,
): monaco.languages.CompletionItem {
  let range: monaco.languages.CompletionItem['range'] = { insert, replace };
  if (it.range) {
    const a = model.getPositionAt(it.range[0]), z = model.getPositionAt(it.range[1]);
    range = new monaco.Range(a.lineNumber, a.column, z.lineNumber, z.column);
  }
  const follow = it.command === 'retrigger' ? 'editor.action.triggerSuggest' : it.command === 'signatureHelp' ? 'editor.action.triggerParameterHints' : '';
  return {
    label: it.description || it.labelDetail ? { label: it.label, detail: it.labelDetail, description: it.description } : it.label,
    kind: KIND[it.kind],
    detail: it.detail,
    documentation: it.documentation ? { value: it.documentation } : undefined,
    insertText: it.insertText,
    insertTextRules: it.isSnippet ? monaco.languages.CompletionItemInsertTextRule.InsertAsSnippet : undefined,
    sortText: it.sortText,
    // Monaco filters on the text inside the range; a quoted prefix with spaces (`[Order `) would never match
    filterText: typedHasSpace ? typed + it.filterText : it.filterText,
    range,
    tags: it.deprecated ? [monaco.languages.CompletionItemTag.Deprecated] : undefined,
    command: { id: ACCEPT_COMMAND, title: '', arguments: [uri, it.usageKey ?? '', follow] },
    additionalTextEdits: it.additionalTextEdits?.map((e) => {
      const a = model.getPositionAt(e.range[0]), z = model.getPositionAt(e.range[1]);
      return { range: new monaco.Range(a.lineNumber, a.column, z.lineNumber, z.column), text: e.text };
    }),
  };
}

/** Idempotent global setup. Safe to call from every SqlEditor mount. */
export function ensureMonacoSetup(): void {
  const gs = globalThis as unknown as Record<string, boolean>;
  if (gs[SETUP_KEY]) return;
  gs[SETUP_KEY] = true;
  const g = globalThis as unknown as { MonacoEnvironment?: { getWorker(id: string, label: string): Worker } };
  g.MonacoEnvironment = { getWorker: () => new EditorWorker() };
  installStyles();
  defineThemes();
  (['tsql', 'plsql', 'sqlite', 'pgsql'] as Dialect[]).forEach(registerLanguage);

  monaco.editor.registerCommand(ACCEPT_COMMAND, (_accessor: unknown, uri: string, usageKey: string, follow: string) => {
    const b = bindingByUri(uri);
    if (!b) return;
    if (usageKey) b.accepted(usageKey);
    // a follow-up suggest is automatic, not explicit: with nothing to offer (a schema whose objects are still
    // loading, a database with no catalog) it shows nothing instead of an empty 'No suggestions.' box
    if (follow) setTimeout(() => b.editor.trigger('dbstudio', follow, followUpPayload(follow)), 0);
  });

  monaco.editor.registerEditorOpener({
    openCodeEditor(source, resource) {
      if (resource.scheme !== 'dbstudio-object') return false;
      const parsed = parseObjectUri(resource.toString());
      const b = parsed?.owner ? bindingByUri(parsed.owner) : bindingForEditor(source);
      if (!parsed || !b) return true;
      b.openObject(parsed.ref, parsed.column);
      return true;
    },
  });
}
