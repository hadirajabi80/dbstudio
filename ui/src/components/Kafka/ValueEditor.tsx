// Value editor of Produce (docs/PLAN-M2.md 7.4: "Monaco for value"). Monaco with a small hand-written JSON Monarch
// language is loaded lazily (its own chunk); under the unit tests (jsdom) a textarea with the same props stands in.
import { lazy, Suspense } from 'react';
import type { EffectiveTheme } from '../../theme/useTheme';

export interface ValueEditorProps {
  value: string;
  onChange(value: string): void;
  /** 'json' highlights and underlines parse errors; 'text' is plain. */
  language: 'json' | 'text';
  ariaLabel: string;
  theme: EffectiveTheme;
  height?: number;
  onSubmit?: () => void;
}

const MonacoValueEditor = lazy(() => import('./monacoValueEditor'));
const IS_TEST = import.meta.env.MODE === 'test';

function TextareaEditor(p: ValueEditorProps) {
  return (
    <textarea
      className="input kafka-textarea kafka-value-textarea"
      aria-label={p.ariaLabel}
      value={p.value}
      spellCheck={false}
      style={{ height: p.height ?? 220 }}
      onChange={(e) => p.onChange(e.target.value)}
      onKeyDown={(e) => {
        if (e.key === 'Enter' && (e.ctrlKey || e.metaKey)) {
          e.preventDefault();
          p.onSubmit?.();
        }
      }}
    />
  );
}

export function ValueEditor(p: ValueEditorProps) {
  if (IS_TEST) return <TextareaEditor {...p} />;
  return (
    <Suspense fallback={<TextareaEditor {...p} />}>
      <MonacoValueEditor {...p} />
    </Suspense>
  );
}
