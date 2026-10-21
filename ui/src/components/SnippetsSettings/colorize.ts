// Monaco-backed SQL colouring for snippet code (its own lazy chunk: it pulls in Monaco). Uses the editor's own
// languages (dbstudio-tsql|plsql|pgsql|sqlite) and themes, so the colours match the console exactly. Synchronous
// once loaded (a scratch model per dialect + colorizeModelLine), so previews re-colour while typing without a flash.
import * as monaco from '../../editor/monaco';
import { ensureMonacoSetup, LANGUAGE_IDS, THEME_IDS } from '../../editor/monaco-setup';
import type { Dialect } from '../../api/types';
import type { EffectiveTheme } from '../../theme/useTheme';
import type { CodeToken } from './code';

const cache = new Map<string, CodeToken[][]>();
const CACHE_MAX = 500;
const scratch = new Map<Dialect, monaco.editor.ITextModel>();
let appliedTheme: EffectiveTheme | null = null;

/** Tokens of one rendered line's HTML (`<span><span class="mtk5">SELECT</span>…</span>`). */
function parseLine(html: string): CodeToken[] {
  const tpl = document.createElement('template');
  tpl.innerHTML = html;
  const out: CodeToken[] = [];
  const walk = (node: Node, cls: string) => {
    for (const child of Array.from(node.childNodes)) {
      if (child.nodeType === Node.TEXT_NODE) {
        // the renderer writes spaces as U+00A0 (and tabs as runs of them)
        const text = (child.nodeValue ?? '').replace(/ /g, ' ');
        if (text) out.push({ cls, text });
      } else if (child instanceof HTMLElement) {
        walk(child, child.className || cls);
      }
    }
  };
  walk(tpl.content, '');
  return out;
}

function modelFor(dialect: Dialect): monaco.editor.ITextModel {
  let m = scratch.get(dialect);
  if (!m || m.isDisposed()) {
    m = monaco.editor.createModel('', LANGUAGE_IDS[dialect], monaco.Uri.parse(`dbstudio-snippet-preview://${dialect}/scratch.sql`));
    scratch.set(dialect, m);
  }
  return m;
}

/** Colours `text` as SQL of `dialect` in the app theme: one token array per line (classes from the Monaco theme). */
export function colorizeSql(text: string, dialect: Dialect, theme: EffectiveTheme): CodeToken[][] {
  ensureMonacoSetup();
  // The mtkN classes index the active theme's colour map: colour with the theme the app shows (the global Monaco
  // theme is the app theme anyway, see theme/monacoTheme.ts applyMonacoTheme).
  if (appliedTheme !== theme) {
    monaco.editor.setTheme(THEME_IDS[theme]);
    appliedTheme = theme;
  }
  const key = `${dialect}\u0001${theme}\u0001${text}`;
  const hit = cache.get(key);
  if (hit) return hit;
  const model = modelFor(dialect);
  model.setValue(text);
  const lines: CodeToken[][] = [];
  for (let ln = 1; ln <= model.getLineCount(); ln++) lines.push(parseLine(monaco.editor.colorizeModelLine(model, ln, 4)));
  if (cache.size >= CACHE_MAX) cache.delete(cache.keys().next().value as string);
  cache.set(key, lines);
  return lines;
}
