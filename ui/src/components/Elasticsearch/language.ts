// Monaco languages of the Elasticsearch views (lazy, with the editor chunk): `dbstudio-es-json` (query DSL / documents:
// highlighting, DSL key + field-name completion, parse-error markers), `dbstudio-es-console` (Dev Tools: methods, API
// paths and index names, DSL inside search bodies) and `dbstudio-es-sql`. Completion reads the model's binding
// (connection, target index) registered by the editor.
import * as monaco from '../../editor/monaco';
import { API_CATALOG, pathSnippet } from '../../es/apiCatalog';
import { CONSOLE_METHODS, indexOfPath, isRequestLine, isSearchPath } from '../../es/console';
import { suggest, valueSnippet, type DslContext, type DslSuggestion } from '../../es/dsl';
import { flavorOf, knownTargets, loadFields } from './store';

export const ES_JSON = 'dbstudio-es-json';
export const ES_CONSOLE = 'dbstudio-es-console';
export const ES_SQL = 'dbstudio-es-sql';

export interface EsCompletionBinding {
  cid: string;
  /** Target index/pattern of a DSL body (json); null = no field names. */
  index?: () => string | null;
  /** json: offer query DSL keys (search bodies). */
  dsl?: boolean;
}

const bindings = new Map<string, () => EsCompletionBinding | null>();

export function bindEsModel(uri: string, get: () => EsCompletionBinding | null): () => void {
  bindings.set(uri, get);
  return () => {
    if (bindings.get(uri) === get) bindings.delete(uri);
  };
}

const JSON_RULES: monaco.languages.IMonarchLanguageRule[] = [
  [/"(?:[^"\\]|\\.)*"(?=\s*:)/, 'type'],
  [/"(?:[^"\\]|\\.)*"/, 'string'],
  [/-?\d+(?:\.\d+)?(?:[eE][+-]?\d+)?/, 'number'],
  [/\b(?:true|false|null)\b/, 'keyword'],
  [/\/\/.*$/, 'comment'],
  [/[{}[\],:]/, 'delimiter'],
];

const SQL_KEYWORDS = [
  'SELECT', 'FROM', 'WHERE', 'GROUP', 'BY', 'ORDER', 'LIMIT', 'HAVING', 'AND', 'OR', 'NOT', 'AS', 'ASC', 'DESC', 'IS', 'NULL', 'IN', 'BETWEEN', 'LIKE',
  'RLIKE', 'DISTINCT', 'SHOW', 'TABLES', 'COLUMNS', 'DESCRIBE', 'FUNCTIONS', 'MATCH', 'QUERY', 'SCORE', 'COUNT', 'SUM', 'AVG', 'MIN', 'MAX', 'CASE', 'WHEN',
  'THEN', 'ELSE', 'END', 'CAST', 'HISTOGRAM', 'INTERVAL', 'PIVOT', 'TRUE', 'FALSE', 'OFFSET', 'ROUND',
];

let registered = false;

export function ensureEsLanguages(): void {
  if (registered) return;
  registered = true;
  const brackets: monaco.languages.CharacterPair[] = [['{', '}'], ['[', ']']];
  const pairs = [{ open: '{', close: '}' }, { open: '[', close: ']' }, { open: '"', close: '"', notIn: ['string'] }];

  monaco.languages.register({ id: ES_JSON });
  monaco.languages.setMonarchTokensProvider(ES_JSON, { tokenizer: { root: JSON_RULES } });
  monaco.languages.setLanguageConfiguration(ES_JSON, { brackets, autoClosingPairs: pairs, surroundingPairs: pairs, comments: { lineComment: '//' } });

  monaco.languages.register({ id: ES_CONSOLE });
  monaco.languages.setMonarchTokensProvider(ES_CONSOLE, {
    ignoreCase: true,
    tokenizer: {
      root: [
        [/^\s*(#|\/\/).*$/, 'comment'],
        [/^(\s*)(GET|POST|PUT|DELETE|HEAD|PATCH)(\s+)(\S+)/, ['', 'keyword', '', 'predefined']],
        ...JSON_RULES,
      ],
    },
  });
  monaco.languages.setLanguageConfiguration(ES_CONSOLE, { brackets, autoClosingPairs: pairs, surroundingPairs: pairs, comments: { lineComment: '#' } });

  monaco.languages.register({ id: ES_SQL });
  monaco.languages.setMonarchTokensProvider(ES_SQL, {
    ignoreCase: true,
    keywords: SQL_KEYWORDS.map((k) => k.toLowerCase()),
    tokenizer: {
      root: [
        [/--.*$/, 'comment'],
        [/'(?:[^']|'')*'/, 'string'],
        [/"(?:[^"]|"")*"/, 'identifier.quote'],
        [/`[^`]*`/, 'identifier.quote'],
        [/-?\d+(?:\.\d+)?/, 'number'],
        [/[a-zA-Z_][\w.-]*/, { cases: { '@keywords': 'keyword', '@default': 'identifier' } }],
        [/[(),;*=<>!+-/]/, 'delimiter'],
      ],
    },
  });
  monaco.languages.setLanguageConfiguration(ES_SQL, {
    comments: { lineComment: '--' }, brackets: [['(', ')']],
    autoClosingPairs: [{ open: '(', close: ')' }, { open: "'", close: "'", notIn: ['string'] }, { open: '"', close: '"', notIn: ['string'] }],
  });

  monaco.languages.registerCompletionItemProvider(ES_JSON, { triggerCharacters: ['"', ':', ' ', '{', ','], provideCompletionItems: jsonItems });
  monaco.languages.registerCompletionItemProvider(ES_CONSOLE, { triggerCharacters: ['"', '/', ' ', '_', '{', ','], provideCompletionItems: consoleItems });
  monaco.languages.registerCompletionItemProvider(ES_SQL, { triggerCharacters: [' ', '"'], provideCompletionItems: sqlItems });
}

// ---- DSL items (shared by json bodies and console bodies)

function dslItems(model: monaco.editor.ITextModel, position: monaco.Position, bodyStart: monaco.IPosition, items: DslSuggestion[], inString: boolean,
  prefix: string): monaco.languages.CompletionItem[] {
  void bodyStart;
  const line = model.getLineContent(position.lineNumber);
  const col = position.column; // 1-based, cursor before line[col-1]
  // replace from the opening quote (or the typed word) to the closing quote right after the cursor
  const startCol = inString ? col - prefix.length - 1 : col - prefix.length;
  const endCol = inString && line[col - 1] === '"' ? col + 1 : col;
  const range = new monaco.Range(position.lineNumber, Math.max(1, startCol), position.lineNumber, endCol);
  const K = monaco.languages.CompletionItemKind;
  return items.map((s, i) => {
    const quoted = JSON.stringify(s.label);
    if (s.type === 'key') {
      return {
        label: s.label, kind: s.detail ? K.Field : K.Property, detail: s.detail ?? s.kind, documentation: s.doc, range, sortText: String(i).padStart(4, '0'),
        insertText: `${quoted}: ${valueSnippet(s.kind)}`, insertTextRules: monaco.languages.CompletionItemInsertTextRule.InsertAsSnippet,
        filterText: inString ? `"${s.label}` : s.label,
      };
    }
    const bare = s.type === 'value' && (s.label === 'true' || s.label === 'false');
    return {
      label: s.label, kind: s.type === 'field' ? K.Field : K.EnumMember, detail: s.detail, range, sortText: String(i).padStart(4, '0'),
      insertText: bare && !inString ? s.label : quoted, filterText: inString ? `"${s.label}` : s.label,
    };
  });
}

async function bodySuggestions(model: monaco.editor.ITextModel, position: monaco.Position, bodyStart: monaco.IPosition, cid: string, index: string | null,
  start: DslContext): Promise<monaco.languages.CompletionList> {
  const text = model.getValueInRange(new monaco.Range(bodyStart.lineNumber, bodyStart.column, position.lineNumber, position.column));
  const fields = index ? await loadFields(cid, index) : [];
  const { cursor, items } = suggest(text, fields, start);
  return { suggestions: dslItems(model, position, bodyStart, items, cursor.inString, cursor.prefix) };
}

async function jsonItems(model: monaco.editor.ITextModel, position: monaco.Position): Promise<monaco.languages.CompletionList> {
  const b = bindings.get(model.uri.toString())?.();
  if (!b?.dsl) return { suggestions: [] };
  return bodySuggestions(model, position, { lineNumber: 1, column: 1 }, b.cid, b.index?.() ?? null, { kind: 'root' });
}

// ---- console

const INDEX_BODY_KEYS: DslSuggestion[] = [
  { label: 'settings', type: 'key', kind: 'obj', doc: 'number_of_shards, number_of_replicas, analysis…' },
  { label: 'mappings', type: 'key', kind: 'obj', doc: '{ "properties": { … } }' },
  { label: 'aliases', type: 'key', kind: 'obj', doc: '{ "alias": {} }' },
];

async function consoleItems(model: monaco.editor.ITextModel, position: monaco.Position): Promise<monaco.languages.CompletionList> {
  const b = bindings.get(model.uri.toString())?.();
  const cid = b?.cid ?? '';
  const line = model.getLineContent(position.lineNumber);
  const before = line.slice(0, position.column - 1);
  const K = monaco.languages.CompletionItemKind;

  // method at the start of a line
  if (/^\s*[A-Za-z]*$/.test(before) && !line.slice(position.column - 1).trim() && isRequestStartSpot(model, position)) {
    const word = before.trimStart();
    const range = new monaco.Range(position.lineNumber, position.column - word.length, position.lineNumber, position.column);
    return { suggestions: CONSOLE_METHODS.map((m, i) => ({ label: m, kind: K.Keyword, insertText: `${m} `, range, sortText: String(i), command: { id: 'editor.action.triggerSuggest', title: '' } })) };
  }

  // path after the method
  const m = /^(\s*)(GET|POST|PUT|DELETE|HEAD)\s+(\S*)$/i.exec(before);
  if (m) {
    const method = m[2].toUpperCase();
    const typed = m[3];
    const range = new monaco.Range(position.lineNumber, position.column - typed.length, position.lineNumber, position.column);
    const flavor = cid ? flavorOf(cid) : 'elasticsearch';
    const out: monaco.languages.CompletionItem[] = [];
    API_CATALOG.forEach((e, i) => {
      if (!e.methods.includes(method)) return;
      if (e.only && e.only !== (flavor === 'opensearch' ? 'os' : 'es')) return;
      out.push({
        label: e.path, kind: K.Function, detail: e.doc, range, sortText: `1${String(i).padStart(3, '0')}`,
        insertText: pathSnippet(e.path), insertTextRules: monaco.languages.CompletionItemInsertTextRule.InsertAsSnippet, filterText: e.path,
      });
    });
    if (cid) {
      for (const name of knownTargets(cid).slice(0, 200)) {
        const suffixes = method === 'GET' || method === 'POST' ? ['/_search', '/_count', '/_mapping', '/_settings'] : method === 'DELETE' ? [''] : ['', '/_doc', '/_mapping'];
        for (const s of suffixes) {
          const p = `/${name}${s}`;
          out.push({ label: p, kind: K.Folder, detail: 'index', range, insertText: p, filterText: p, sortText: `0${p}` });
        }
      }
    }
    return { suggestions: out };
  }

  // body: find the request line above
  let header = -1;
  for (let l = position.lineNumber - 1; l >= 1; l--) {
    if (isRequestLine(model.getLineContent(l))) {
      header = l;
      break;
    }
  }
  if (header < 0) return { suggestions: [] };
  const hm = /^\s*(GET|POST|PUT|DELETE|HEAD)\s+(\S+)/i.exec(model.getLineContent(header));
  if (!hm) return { suggestions: [] };
  const method = hm[1].toUpperCase();
  const path = hm[2];
  const bodyStart = { lineNumber: header + 1, column: 1 };
  if (isSearchPath(path)) return bodySuggestions(model, position, bodyStart, cid, indexOfPath(path), { kind: 'root' });
  if (method === 'PUT' && /^\/?[^_/][^/?]*\/?(\?.*)?$/.test(path)) {
    const text = model.getValueInRange(new monaco.Range(bodyStart.lineNumber, 1, position.lineNumber, position.column));
    const { cursor } = suggest(text, []);
    if (cursor.inKey && cursor.path.length === 0) return { suggestions: dslItems(model, position, bodyStart, INDEX_BODY_KEYS, cursor.inString, cursor.prefix) };
  }
  return { suggestions: [] };
}

/** A method can be typed here: no request body is open above (the previous request's JSON is closed). */
function isRequestStartSpot(model: monaco.editor.ITextModel, position: monaco.Position): boolean {
  let depth = 0;
  for (let l = position.lineNumber - 1; l >= 1; l--) {
    const text = model.getLineContent(l);
    if (isRequestLine(text)) return depth <= 0;
    for (const ch of text.replace(/"(?:[^"\\]|\\.)*"/g, '')) {
      if (ch === '{' || ch === '[') depth++;
      else if (ch === '}' || ch === ']') depth--;
    }
  }
  return true;
}

// ---- SQL

async function sqlItems(model: monaco.editor.ITextModel, position: monaco.Position): Promise<monaco.languages.CompletionList> {
  const b = bindings.get(model.uri.toString())?.();
  const word = model.getWordUntilPosition(position);
  const range = new monaco.Range(position.lineNumber, word.startColumn, position.lineNumber, word.endColumn);
  const K = monaco.languages.CompletionItemKind;
  const text = model.getValue();
  const before = model.getValueInRange(new monaco.Range(1, 1, position.lineNumber, position.column));
  const out: monaco.languages.CompletionItem[] = [];
  const quote = b?.cid && flavorOf(b.cid) === 'opensearch' ? '`' : '"';
  if (b?.cid && /\bFROM\s+["`]?[\w.*-]*$/i.test(before)) {
    for (const t of knownTargets(b.cid)) out.push({ label: t, kind: K.Struct, detail: 'index', range, insertText: /^[a-z0-9_]+$/.test(t) ? t : `${quote}${t}${quote}` });
    return { suggestions: out };
  }
  const from = /\bFROM\s+["`]?([\w.*-]+)["`]?/i.exec(text)?.[1];
  if (b?.cid && from) {
    for (const f of await loadFields(b.cid, from)) {
      if (f.type === 'object' || f.type === 'nested') continue;
      out.push({ label: f.path, kind: K.Field, detail: f.type, range, insertText: /^[A-Za-z_][\w]*$/.test(f.path) ? f.path : `"${f.path}"`, sortText: `0${f.path}` });
    }
  }
  for (const k of SQL_KEYWORDS) out.push({ label: k, kind: K.Keyword, range, insertText: k, sortText: `1${k}` });
  return { suggestions: out };
}
