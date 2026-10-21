// Monaco language `dbstudio-mongo` (docs/PLAN-M2.md 6.3): a Monarch tokenizer for shell JSON (keys, $operators,
// helpers such as ObjectId()/ISODate(), regex literals), completion from mongo/complete.ts and operator hover docs.
// Per-editor completion context (mode + sampled fields) is looked up by model URI, so many editors share one provider.
import type { MongoFieldPath } from '../../api/types';
import * as monaco from '../../editor/monaco';
import { caretContext, suggest, type CompletionMode, type SuggestionKind } from '../../mongo/complete';
import { operatorDoc } from '../../mongo/operators';

export const MONGO_LANGUAGE = 'dbstudio-mongo';

export interface MongoModelBinding {
  mode: () => CompletionMode;
  fields: () => readonly MongoFieldPath[];
}

const bindings = new Map<string, MongoModelBinding>();

export function bindMongoModel(uri: string, b: MongoModelBinding): () => void {
  bindings.set(uri, b);
  return () => {
    if (bindings.get(uri) === b) bindings.delete(uri);
  };
}

const KIND: Record<SuggestionKind, monaco.languages.CompletionItemKind> = {
  field: monaco.languages.CompletionItemKind.Field,
  operator: monaco.languages.CompletionItemKind.Operator,
  stage: monaco.languages.CompletionItemKind.Module,
  value: monaco.languages.CompletionItemKind.Value,
  helper: monaco.languages.CompletionItemKind.Constructor,
  keyword: monaco.languages.CompletionItemKind.Keyword,
};

const KEY = '__dbstudioMongoLanguage';

export function ensureMongoLanguage(): void {
  const g = globalThis as unknown as Record<string, boolean>;
  if (g[KEY]) return;
  g[KEY] = true;
  monaco.languages.register({ id: MONGO_LANGUAGE });
  monaco.languages.setLanguageConfiguration(MONGO_LANGUAGE, {
    comments: { lineComment: '//', blockComment: ['/*', '*/'] },
    brackets: [['{', '}'], ['[', ']'], ['(', ')']],
    autoClosingPairs: [
      { open: '{', close: '}' }, { open: '[', close: ']' }, { open: '(', close: ')' },
      { open: '"', close: '"', notIn: ['string'] }, { open: "'", close: "'", notIn: ['string'] },
    ],
    surroundingPairs: [{ open: '{', close: '}' }, { open: '[', close: ']' }, { open: '"', close: '"' }],
    wordPattern: /(-?\d*\.\d\w*)|([$\w.]+)/,
  });
  monaco.languages.setMonarchTokensProvider(MONGO_LANGUAGE, {
    helpers: ['ObjectId', 'ISODate', 'Date', 'NumberLong', 'Long', 'NumberInt', 'Int32', 'NumberDecimal', 'Decimal128', 'Double',
      'BinData', 'HexData', 'UUID', 'MD5', 'Timestamp', 'MinKey', 'MaxKey', 'RegExp', 'Code', 'DBRef', 'new'],
    literals: ['true', 'false', 'null', 'undefined', 'NaN', 'Infinity'],
    tokenizer: {
      root: [
        [/\/\/.*$/, 'comment'],
        [/\/\*/, 'comment', '@comment'],
        [/"\$[\w.]*"(?=\s*:)/, 'keyword'],
        [/'\$[\w.]*'(?=\s*:)/, 'keyword'],
        [/"(?:[^"\\]|\\.)*"(?=\s*:)/, 'variable'],
        [/'(?:[^'\\]|\\.)*'(?=\s*:)/, 'variable'],
        [/\$[\w.]*(?=\s*:)/, 'keyword'],
        [/[A-Za-z_][\w.]*(?=\s*:)/, 'variable'],
        [/"\$[^"]*"/, 'type'],
        [/"(?:[^"\\]|\\.)*"/, 'string'],
        [/'(?:[^'\\]|\\.)*'/, 'string'],
        [/"(?:[^"\\]|\\.)*$/, 'string'],
        [/\/(?:[^/\\\n]|\\.)+\/[a-z]*/, 'string'],
        [/-?(?:\d+\.?\d*|\.\d+)(?:[eE][+-]?\d+)?/, 'number'],
        [/[A-Za-z_][\w]*/, { cases: { '@helpers': 'predefined', '@literals': 'keyword.contextual', '@default': 'identifier' } }],
        [/[{}[\]()]/, 'delimiter.parenthesis'],
        [/[:,]/, 'delimiter'],
      ],
      comment: [
        [/[^*]+/, 'comment'],
        [/\*\//, 'comment', '@pop'],
        [/\*/, 'comment'],
      ],
    },
  } as monaco.languages.IMonarchLanguage);

  monaco.languages.registerCompletionItemProvider(MONGO_LANGUAGE, {
    triggerCharacters: ['$', '"', "'", '{', ',', ':', ' ', '.'],
    provideCompletionItems(model, position) {
      const b = bindings.get(model.uri.toString());
      if (!b) return { suggestions: [] };
      const text = model.getValue();
      const offset = model.getOffsetAt(position);
      const ctx = caretContext(text, offset);
      if (ctx.where === 'none') return { suggestions: [] };
      const items = suggest(b.mode(), ctx, b.fields());
      const startOffset = ctx.quote ? ctx.start + 1 : ctx.start;
      const start = model.getPositionAt(startOffset);
      const range = new monaco.Range(start.lineNumber, start.column, position.lineNumber, position.column);
      return {
        suggestions: items.slice(0, 200).map((s, i) => ({
          label: s.label,
          kind: KIND[s.kind],
          insertText: s.insert,
          insertTextRules: s.snippet ? monaco.languages.CompletionItemInsertTextRule.InsertAsSnippet : undefined,
          detail: s.detail,
          documentation: s.doc,
          range,
          sortText: `${String(s.rank).padStart(3, '0')}${String(i).padStart(4, '0')}`,
          filterText: ctx.quote ? s.label : undefined,
        })),
      };
    },
  });

  monaco.languages.registerHoverProvider(MONGO_LANGUAGE, {
    provideHover(model, position) {
      const word = model.getWordAtPosition(position);
      if (!word || !word.word.startsWith('$')) return null;
      const name = word.word.split('.')[0];
      const doc = operatorDoc(name);
      if (!doc) return null;
      return {
        range: new monaco.Range(position.lineNumber, word.startColumn, position.lineNumber, word.startColumn + name.length),
        contents: [{ value: `**${doc.name}** — ${doc.summary}` }, { value: `\`${doc.syntax}\`` }],
      };
    },
  });
}
