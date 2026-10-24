// Code editor of the Elasticsearch views: Monaco (lazy chunk, languages in ./language.ts) with a textarea stand-in under
// the unit tests (jsdom) and while Monaco loads. The imperative handle gives the console the cursor/selection lines.
import { lazy, Suspense, useImperativeHandle, useRef, type MutableRefObject } from 'react';
import type { EffectiveTheme } from '../../theme/useTheme';
import type { EsCompletionBinding } from './language';

export type EsEditorLanguage = 'json' | 'console' | 'sql' | 'text';

export interface EditorHandle {
  /** 1-based line of the cursor. */
  cursorLine(): number;
  /** Selected line range, or null without a selection. */
  selectionLines(): { from: number; to: number } | null;
  focus(): void;
  /** Moves the cursor to a line (and reveals it). */
  goToLine(line: number): void;
}

export interface CodeEditorProps {
  value: string;
  onChange?(value: string): void;
  language: EsEditorLanguage;
  ariaLabel: string;
  theme: EffectiveTheme;
  readOnly?: boolean;
  /** Pixel height; default fills the parent (flex). */
  height?: number;
  /** Ctrl/Cmd+Enter. */
  onRun?(): void;
  /** Ctrl/Cmd+Shift+Enter. */
  onRunAll?(): void;
  /** Console: ▶ in the gutter of a request line. */
  onRunLine?(line: number): void;
  completion?: EsCompletionBinding;
  /** json: underline parse errors (default true for editable json). */
  validate?: boolean;
  wordWrap?: boolean;
  handleRef?: MutableRefObject<EditorHandle | null>;
  className?: string;
  autoFocus?: boolean;
  /** Marks the element as the tab's primary focus target. */
  primary?: boolean;
}

const MonacoEditor = lazy(() => import('./monacoEditor'));
const IS_TEST = import.meta.env.MODE === 'test';

function TextareaEditor(p: CodeEditorProps) {
  const ref = useRef<HTMLTextAreaElement>(null);
  useImperativeHandle(p.handleRef, () => ({
    cursorLine: () => {
      const el = ref.current;
      return el ? el.value.slice(0, el.selectionStart).split('\n').length : 1;
    },
    selectionLines: () => {
      const el = ref.current;
      if (!el || el.selectionStart === el.selectionEnd) return null;
      return { from: el.value.slice(0, el.selectionStart).split('\n').length, to: el.value.slice(0, el.selectionEnd).split('\n').length };
    },
    focus: () => ref.current?.focus(),
    goToLine: () => ref.current?.focus(),
  }));
  return (
    <textarea
      ref={ref}
      className={`input es-textarea ${p.className ?? ''}`}
      aria-label={p.ariaLabel}
      value={p.value}
      readOnly={p.readOnly}
      spellCheck={false}
      autoFocus={p.autoFocus}
      data-primary-focus={p.primary ? '' : undefined}
      style={p.height ? { height: p.height } : undefined}
      onChange={(e) => p.onChange?.(e.target.value)}
      onKeyDown={(e) => {
        if (e.key === 'Enter' && (e.ctrlKey || e.metaKey)) {
          e.preventDefault();
          if (e.shiftKey) p.onRunAll?.();
          else p.onRun?.();
        }
      }}
    />
  );
}

export function CodeEditor(p: CodeEditorProps) {
  if (IS_TEST) return <TextareaEditor {...p} />;
  return (
    <Suspense fallback={<TextareaEditor {...p} />}>
      <MonacoEditor {...p} />
    </Suspense>
  );
}
