// Read-only snippet code coloured like the SQL editor (Monaco's colorizer with the dialect's language and the app
// theme), with the tab stops ($1, ${1:x}, $0) marked. Shows plain text until the colouring chunk has loaded, and in
// unit tests (jsdom has no Monaco).
import { useEffect, useMemo, useState, type ReactNode } from 'react';
import type { Dialect } from '../../api/types';
import type { EffectiveTheme } from '../../theme/useTheme';
import { placeholders, plainLines, segmentLine, type CodeSegment, type CodeToken } from './code';

const IS_TEST = import.meta.env.MODE === 'test';

export interface SnippetCodeProps {
  code: string;
  dialect: Dialect;
  theme: EffectiveTheme;
  /** Preview: at most this many lines (leading blank lines skipped), each clipped with an ellipsis. */
  maxLines?: number;
  /** Mark tab stops (snippet bodies); off for the "Inserts" preview. */
  markPlaceholders?: boolean;
  className?: string;
  'aria-label'?: string;
  'aria-hidden'?: boolean;
}

type Colorizer = typeof import('./colorize');
let colorizer: Colorizer | null = null;
let loading: Promise<Colorizer> | null = null;

function loadColorizer(): Promise<Colorizer> {
  loading ??= import('./colorize').then((m) => (colorizer = m));
  return loading;
}

/** Monaco token lines of `code` (synchronous once the colouring chunk is loaded), or null until then. */
function useColoredLines(code: string, dialect: Dialect, theme: EffectiveTheme): CodeToken[][] | null {
  const [loaded, setLoaded] = useState(!!colorizer);
  useEffect(() => {
    if (IS_TEST || colorizer) return;
    let live = true;
    loadColorizer().then(() => { if (live) setLoaded(true); }, (e) => console.warn('[snippets] colouring unavailable', e));
    return () => { live = false; };
  }, []);
  return useMemo(() => {
    if (!loaded || !colorizer || !code) return null;
    try {
      return colorizer.colorizeSql(code, dialect, theme);
    } catch (e) {
      console.warn('[snippets] colouring failed', e);
      return null;
    }
  }, [code, dialect, theme, loaded]);
}

function renderLine(tokens: readonly CodeToken[], mark: boolean): ReactNode[] {
  const text = tokens.map((t) => t.text).join('');
  const phs = mark ? placeholders(text) : [];
  const segs = segmentLine(tokens, phs);
  const out: ReactNode[] = [];
  let group: { ph: number; parts: CodeSegment[] } | null = null;
  const flush = () => {
    if (!group) return;
    const p = phs[group.ph];
    out.push(
      <span key={`p${out.length}`} className={`snip-ph${p.final ? ' snip-ph-final' : ''}`}>
        {group.parts.map((s, i) => <span key={i} className={s.cls || undefined}>{s.text}</span>)}
      </span>,
    );
    group = null;
  };
  for (const s of segs) {
    if (s.ph >= 0) {
      if (group && group.ph !== s.ph) flush();
      if (!group) group = { ph: s.ph, parts: [] };
      group.parts.push(s);
    } else {
      flush();
      out.push(<span key={`t${out.length}`} className={s.cls || undefined}>{s.text}</span>);
    }
  }
  flush();
  return out;
}

export function SnippetCode({ code, dialect, theme, maxLines, markPlaceholders = true, className, ...aria }: SnippetCodeProps) {
  const colored = useColoredLines(code, dialect, theme);
  const lines = useMemo(() => colored ?? plainLines(code), [colored, code]);
  let shown = lines;
  let more = false;
  if (maxLines) {
    let first = lines.findIndex((l) => l.some((t) => t.text.trim()));
    if (first < 0) first = 0;
    shown = lines.slice(first, first + maxLines);
    more = lines.slice(first + maxLines).some((l) => l.some((t) => t.text.trim()));
  }
  return (
    <pre
      className={`snip-code-view${maxLines ? ' snip-code-clamp' : ''}${colored ? ' snip-code-colored' : ''}${className ? ` ${className}` : ''}`}
      aria-label={aria['aria-label']}
      aria-hidden={aria['aria-hidden'] || undefined}
    >
      {shown.map((l, i) => (
        <span key={i} className="snip-code-line">
          {renderLine(l, markPlaceholders)}
          {more && i === shown.length - 1 && <span className="snip-code-more"> …</span>}
          {l.length === 0 && '​'}
        </span>
      ))}
    </pre>
  );
}
