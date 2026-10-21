// Code editor of the Redis views (Workbench, string and JSON values). The real editor is Monaco (lazy chunk, the
// dbstudio-redis / dbstudio-redis-json languages of redis/language.ts); under the unit tests (jsdom) a textarea with
// the same props and key handling stands in.
import { lazy, Suspense } from 'react';
import type { EffectiveTheme } from '../../theme/useTheme';

export interface CodeEditorProps {
  value: string;
  onChange?: (value: string) => void;
  language: 'redis' | 'json' | 'text';
  theme: EffectiveTheme;
  ariaLabel: string;
  readOnly?: boolean;
  /** Ctrl/Cmd+Enter: the current line or the selection (Workbench); `text` is that line/selection. */
  onRunSelection?: (text: string, line: number) => void;
  /** F5 / Ctrl+Shift+Enter: every line. */
  onRunAll?: () => void;
  /** Ctrl/Cmd+S. */
  onSave?: () => void;
  /** Workbench key completion. */
  keys?: () => readonly string[];
  placeholder?: string;
  autoFocus?: boolean;
  wordWrap?: boolean;
  className?: string;
}

const MonacoCodeEditor = lazy(() => import('./monacoEditor'));

const IS_TEST = import.meta.env.MODE === 'test';

/** The line under the caret (or the selected text) of a textarea. */
export function selectionOrLine(el: HTMLTextAreaElement): { text: string; line: number } {
  const { value, selectionStart: s, selectionEnd: e } = el;
  const line = value.slice(0, s).split('\n').length;
  if (e > s) return { text: value.slice(s, e), line };
  const start = value.lastIndexOf('\n', s - 1) + 1;
  const end = value.indexOf('\n', s);
  return { text: value.slice(start, end < 0 ? value.length : end), line };
}

function TextareaEditor(p: CodeEditorProps) {
  return (
    <textarea
      className={`input mono redis-code-textarea ${p.className ?? ''}`}
      aria-label={p.ariaLabel}
      value={p.value}
      readOnly={p.readOnly}
      placeholder={p.placeholder}
      autoFocus={p.autoFocus}
      spellCheck={false}
      data-primary-focus
      onChange={(e) => p.onChange?.(e.target.value)}
      onKeyDown={(e) => {
        const mod = e.ctrlKey || e.metaKey;
        if (e.key === 'Enter' && mod && !e.shiftKey && p.onRunSelection) {
          e.preventDefault();
          e.stopPropagation();
          const s = selectionOrLine(e.currentTarget);
          p.onRunSelection(s.text, s.line);
        } else if ((e.key === 'F5' || (e.key === 'Enter' && mod && e.shiftKey)) && p.onRunAll) {
          e.preventDefault();
          e.stopPropagation();
          p.onRunAll();
        } else if (mod && e.key.toLowerCase() === 's' && p.onSave) {
          e.preventDefault();
          e.stopPropagation();
          p.onSave();
        }
      }}
    />
  );
}

export function CodeEditor(props: CodeEditorProps) {
  if (IS_TEST) return <TextareaEditor {...props} />;
  return (
    <Suspense fallback={<TextareaEditor {...props} />}>
      <MonacoCodeEditor {...props} />
    </Suspense>
  );
}
