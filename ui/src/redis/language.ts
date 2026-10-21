// Monaco languages of the Redis views (docs/PLAN-M2.md 5.4):
//   dbstudio-redis       Workbench/CLI: Monarch tokenizer (command words from redis-commands.json, strings, numbers,
//                        `#` and `//` comments), completion (commands, sub-commands, keywords, cached key names),
//                        hover docs (summary, syntax, since, complexity) and argument hints.
//   dbstudio-redis-json  String / RedisJSON value editors: a small JSON tokenizer (Monaco's bundled languages are
//                        not shipped, see editor/monaco.ts).
// Per-editor context (cached key names) is looked up by model URI, so many editors share one provider.
import * as monaco from '../editor/monaco';
import { COMMANDS, commandDoc, findCommand } from './catalog';
import { signature, suggest, type SuggestionKind } from './complete';
import { lineContext } from './args';

export const REDIS_LANGUAGE = 'dbstudio-redis';
export const REDIS_JSON_LANGUAGE = 'dbstudio-redis-json';

export interface RedisModelBinding {
  keys: () => readonly string[];
}

const bindings = new Map<string, RedisModelBinding>();

export function bindRedisModel(uri: string, b: RedisModelBinding): () => void {
  bindings.set(uri, b);
  return () => {
    if (bindings.get(uri) === b) bindings.delete(uri);
  };
}

const KIND: Record<SuggestionKind, monaco.languages.CompletionItemKind> = {
  command: monaco.languages.CompletionItemKind.Function,
  subcommand: monaco.languages.CompletionItemKind.Method,
  keyword: monaco.languages.CompletionItemKind.Keyword,
  key: monaco.languages.CompletionItemKind.Field,
};

const FLAG = '__dbstudioRedisLanguages';

export function ensureRedisLanguages(): void {
  const g = globalThis as unknown as Record<string, boolean>;
  if (g[FLAG]) return;
  g[FLAG] = true;

  const words = [...new Set(COMMANDS.flatMap((c) => c.name.split(' ')))];
  monaco.languages.register({ id: REDIS_LANGUAGE });
  monaco.languages.setLanguageConfiguration(REDIS_LANGUAGE, {
    comments: { lineComment: '#' },
    autoClosingPairs: [{ open: '"', close: '"', notIn: ['string'] }, { open: "'", close: "'", notIn: ['string'] }, { open: '{', close: '}' }, { open: '[', close: ']' }],
    wordPattern: /[^\s"']+/,
  });
  monaco.languages.setMonarchTokensProvider(REDIS_LANGUAGE, {
    ignoreCase: true,
    commands: words,
    tokenizer: {
      root: [
        [/^\s*(#|\/\/).*$/, 'comment'],
        [/^\s*[\w.]+/, { cases: { '@commands': 'keyword', '@default': 'identifier' } }],
        [/"/, 'string', '@dstring'],
        [/'/, 'string', '@sstring'],
        [/-?\d+(\.\d+)?(?=\s|$)/, 'number'],
        [/\b[A-Z][A-Z0-9_-]+\b/, 'type'],
        [/[^\s"']+/, 'variable'],
      ],
      dstring: [[/\\x[0-9a-fA-F]{2}|\\./, 'string.escape'], [/[^\\"]+/, 'string'], [/"/, 'string', '@pop']],
      sstring: [[/\\'/, 'string.escape'], [/[^\\']+/, 'string'], [/'/, 'string', '@pop']],
    },
  });
  monaco.languages.registerCompletionItemProvider(REDIS_LANGUAGE, {
    triggerCharacters: [' ', ':'],
    provideCompletionItems(model, position) {
      const before = model.getLineContent(position.lineNumber).slice(0, position.column - 1);
      if (/^\s*(#|\/\/)/.test(before)) return { suggestions: [] };
      const binding = bindings.get(model.uri.toString());
      const r = suggest(before, binding?.keys);
      const range = new monaco.Range(position.lineNumber, r.start + 1, position.lineNumber, position.column);
      return {
        suggestions: r.items.map((s, i) => ({
          label: s.label,
          kind: KIND[s.kind],
          insertText: s.kind === 'command' || s.kind === 'subcommand' || s.kind === 'keyword' ? `${s.insert} ` : s.insert,
          detail: s.spec ? s.spec.syntax : s.detail,
          documentation: s.spec ? { value: commandDoc(s.spec) } : undefined,
          range,
          sortText: String(i).padStart(4, '0'),
          command: s.kind === 'key' ? undefined : { id: 'editor.action.triggerSuggest', title: 'suggest' },
        })),
      };
    },
  });
  monaco.languages.registerHoverProvider(REDIS_LANGUAGE, {
    provideHover(model, position) {
      const line = model.getLineContent(position.lineNumber);
      const ctx = lineContext(line);
      const words = [...ctx.args, ctx.current].filter(Boolean);
      const spec = findCommand(words);
      if (!spec) return null;
      const first = line.search(/\S/);
      const nameEnd = first + spec.name.length;
      if (position.column - 1 < first || position.column - 1 > nameEnd) return null;
      return {
        range: new monaco.Range(position.lineNumber, first + 1, position.lineNumber, nameEnd + 1),
        contents: [{ value: commandDoc(spec) }],
      };
    },
  });
  monaco.languages.registerSignatureHelpProvider(REDIS_LANGUAGE, {
    signatureHelpTriggerCharacters: [' '],
    provideSignatureHelp(model, position) {
      const before = model.getLineContent(position.lineNumber).slice(0, position.column - 1);
      const sig = signature(before);
      if (!sig) return null;
      const label = sig.spec.syntax;
      const params = sig.placeholder ? [{ label: sig.placeholder }] : [];
      return {
        value: { signatures: [{ label, documentation: sig.spec.summary, parameters: params }], activeSignature: 0, activeParameter: 0 },
        dispose: () => {},
      };
    },
  });

  monaco.languages.register({ id: REDIS_JSON_LANGUAGE });
  monaco.languages.setLanguageConfiguration(REDIS_JSON_LANGUAGE, {
    brackets: [['{', '}'], ['[', ']']],
    autoClosingPairs: [{ open: '{', close: '}' }, { open: '[', close: ']' }, { open: '"', close: '"', notIn: ['string'] }],
  });
  monaco.languages.setMonarchTokensProvider(REDIS_JSON_LANGUAGE, {
    tokenizer: {
      root: [
        [/"(?:[^"\\]|\\.)*"(?=\s*:)/, 'type'],
        [/"(?:[^"\\]|\\.)*"/, 'string'],
        [/-?\d+(\.\d+)?([eE][-+]?\d+)?/, 'number'],
        [/\b(true|false|null)\b/, 'keyword'],
        [/[{}[\],:]/, 'delimiter'],
      ],
    },
  });
}
