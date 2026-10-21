// Shell-JSON editor used by the query bar, the stage cards, the document editor and the validation editor. The real
// editor is Monaco (`dbstudio-mongo` language, completion, hover docs, parse-error markers), loaded lazily so the
// Mongo chunk stays small; under the unit tests (jsdom) a textarea with the same props stands in.
import { lazy, Suspense, type CSSProperties } from 'react';
import type { MongoFieldPath } from '../../api/types';
import type { CompletionMode } from '../../mongo/complete';
import type { EffectiveTheme } from '../../theme/useTheme';

export interface MongoEditorProps {
  value: string;
  onChange?: (value: string) => void;
  /** Completion context. */
  mode: CompletionMode;
  fields?: readonly MongoFieldPath[];
  /** What a valid text is (parse errors are underlined): a document (default), an array, any value, or no check. */
  validate?: 'doc' | 'array' | 'value' | 'none';
  /** Query-bar style: one line that grows while the text has more lines (Enter submits, Shift+Enter breaks). */
  singleLine?: boolean;
  /** Multi-line editors: fixed height in px, or 'auto' (grows up to maxHeight). */
  height?: number | 'auto';
  maxHeight?: number;
  minHeight?: number;
  /** Enter (single-line) or Ctrl/Cmd+Enter. */
  onSubmit?: () => void;
  readOnly?: boolean;
  placeholder?: string;
  ariaLabel: string;
  theme: EffectiveTheme;
  autoFocus?: boolean;
  className?: string;
  style?: CSSProperties;
  /** Line numbers in multi-line editors (default true). */
  lineNumbers?: boolean;
  invalid?: boolean;
}

const MonacoMongoEditor = lazy(() => import('./monacoEditor'));

const IS_TEST = import.meta.env.MODE === 'test';

function TextareaEditor(p: MongoEditorProps) {
  return (
    <textarea
      className={`mongo-textarea ${p.singleLine ? 'single' : ''} ${p.className ?? ''}`}
      aria-label={p.ariaLabel}
      aria-invalid={p.invalid || undefined}
      value={p.value}
      readOnly={p.readOnly}
      placeholder={p.placeholder}
      autoFocus={p.autoFocus}
      spellCheck={false}
      rows={p.singleLine ? 1 : 6}
      style={p.style}
      onChange={(e) => p.onChange?.(e.target.value)}
      onKeyDown={(e) => {
        if (e.key === 'Enter' && (p.singleLine ? !e.shiftKey : e.ctrlKey || e.metaKey)) {
          e.preventDefault();
          p.onSubmit?.();
        }
      }}
    />
  );
}

export function MongoEditor(props: MongoEditorProps) {
  if (IS_TEST) return <TextareaEditor {...props} />;
  return (
    <Suspense fallback={<TextareaEditor {...props} />}>
      <MonacoMongoEditor {...props} />
    </Suspense>
  );
}
