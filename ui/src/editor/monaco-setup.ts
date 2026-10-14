// One-time global Monaco setup: worker, the three DbStudio SQL languages, lexer-driven tokens, themes and the
// language feature providers. Providers resolve per-model state through the registry (multi-editor safe).
import * as monaco from './monaco';
import EditorWorker from 'monaco-editor/editor/editor.worker?worker';
import type { Dialect } from '../api/types';
import { getSpec, type CompletionItem, type CompletionKind, type LexState } from '../intel';
import { tokenizeLine } from './tokens-core';
import { bindingByUri, bindingFor, bindingForEditor } from './registry';
import { objectUri, parseObjectUri, objectSummary } from './object-uri';

export const LANGUAGE_IDS: Record<Dialect, string> = {
  tsql: 'dbstudio-tsql',
  plsql: 'dbstudio-plsql',
  sqlite: 'dbstudio-sqlite',
};

export const THEME_IDS = { light: 'dbstudio-light', dark: 'dbstudio-dark' } as const;

export const TRIGGER_CHARACTERS = ['.', '(', ',', '@', ':', '#', '[', '"', ' '];

/** A space only opens the popup after these keywords (DataGrip style: `FROM `, `JOIN `, `ON ` ...). */
const SPACE_TRIGGER_AFTER = /(^|[\s(,])(FROM|JOIN|UPDATE|INTO|EXEC|EXECUTE|CALL|ON|USING|APPLY)\s$/i;

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
.dbstudio-run-flash { background: rgba(255, 196, 0, 0.28); transition: background 0.4s ease-out; }
.vs-dark .dbstudio-run-flash, .monaco-editor.vs-dark .dbstudio-run-flash { background: rgba(255, 196, 0, 0.18); }
.dbstudio-run-flash-off { background: transparent; transition: background 0.5s ease-out; }
`;
  document.head.appendChild(st);
}

function defineThemes(): void {
  monaco.editor.defineTheme(THEME_IDS.light, {
    base: 'vs', inherit: true,
    rules: [
      { token: '', foreground: '1f2328' },
      { token: 'keyword', foreground: '0033b3', fontStyle: 'bold' },
      { token: 'keyword.contextual', foreground: '0033b3' },
      { token: 'keyword.batch', foreground: '9b2393', fontStyle: 'bold' },
      { token: 'type', foreground: '1a7f8e' },
      { token: 'predefined', foreground: '795e26' },
      { token: 'identifier', foreground: '1f2328' },
      { token: 'identifier.quote', foreground: '7a3e9d' },
      { token: 'string', foreground: '067d17' },
      { token: 'number', foreground: '1750eb' },
      { token: 'comment', foreground: '8c8c8c', fontStyle: 'italic' },
      { token: 'variable', foreground: '871094' },
      { token: 'operator', foreground: '3a3a3a' },
      { token: 'delimiter', foreground: '3a3a3a' },
      { token: 'delimiter.parenthesis', foreground: '3a3a3a' },
    ],
    colors: {
      'editor.background': '#ffffff',
      'editor.foreground': '#1f2328',
      'editor.lineHighlightBackground': '#f5f8fe',
      'editor.selectionBackground': '#a6c8ff',
      'editor.inactiveSelectionBackground': '#d6e4fb',
      'editorLineNumber.foreground': '#adb5bd',
      'editorLineNumber.activeForeground': '#495057',
      'editorCursor.foreground': '#1f2328',
      'editorIndentGuide.background1': '#eceff3',
      'editorWhitespace.foreground': '#d0d7de',
      'editorBracketMatch.background': '#e2e6ff',
      'editorBracketMatch.border': '#9aa8ff',
    },
  });
  monaco.editor.defineTheme(THEME_IDS.dark, {
    base: 'vs-dark', inherit: true,
    rules: [
      { token: '', foreground: 'd4d4d4' },
      { token: 'keyword', foreground: '6ca6e8', fontStyle: 'bold' },
      { token: 'keyword.contextual', foreground: '6ca6e8' },
      { token: 'keyword.batch', foreground: 'c586c0', fontStyle: 'bold' },
      { token: 'type', foreground: '4ec9b0' },
      { token: 'predefined', foreground: 'dcdcaa' },
      { token: 'identifier', foreground: 'd4d4d4' },
      { token: 'identifier.quote', foreground: 'd7ba7d' },
      { token: 'string', foreground: 'ce9178' },
      { token: 'number', foreground: 'b5cea8' },
      { token: 'comment', foreground: '7f9f7f', fontStyle: 'italic' },
      { token: 'variable', foreground: '9cdcfe' },
      { token: 'operator', foreground: 'c8c8c8' },
      { token: 'delimiter', foreground: 'b4b4b4' },
      { token: 'delimiter.parenthesis', foreground: 'c8c8c8' },
    ],
    colors: {
      'editor.background': '#1e1f22',
      'editor.foreground': '#d4d4d4',
      'editor.lineHighlightBackground': '#26282e',
      'editor.selectionBackground': '#214283',
      'editor.inactiveSelectionBackground': '#2b3a55',
      'editorLineNumber.foreground': '#5c6370',
      'editorLineNumber.activeForeground': '#a9b1bd',
      'editorCursor.foreground': '#e6e6e6',
      'editorIndentGuide.background1': '#2c2f36',
      'editorWhitespace.foreground': '#3b3f46',
      'editorBracketMatch.background': '#3b4252',
      'editorBracketMatch.border': '#6c7a96',
      'editorSuggestWidget.background': '#25272c',
      'editorSuggestWidget.border': '#3a3d44',
      'editorSuggestWidget.selectedBackground': '#2f4a73',
      'editorHoverWidget.background': '#25272c',
      'editorHoverWidget.border': '#3a3d44',
    },
  });
}

function registerLanguage(dialect: Dialect): void {
  const id = LANGUAGE_IDS[dialect];
  const spec = getSpec(dialect);
  monaco.languages.register({ id, extensions: [], aliases: [dialect === 'tsql' ? 'T-SQL' : dialect === 'plsql' ? 'PL/SQL' : 'SQLite'] });
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
      return { suggestions, incomplete: res.isIncomplete };
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
    label: it.description ? { label: it.label, description: it.description } : it.label,
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
  (['tsql', 'plsql', 'sqlite'] as Dialect[]).forEach(registerLanguage);

  monaco.editor.registerCommand(ACCEPT_COMMAND, (_accessor: unknown, uri: string, usageKey: string, follow: string) => {
    const b = bindingByUri(uri);
    if (!b) return;
    if (usageKey) b.accepted(usageKey);
    if (follow) setTimeout(() => b.editor.trigger('dbstudio', follow, {}), 0);
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
