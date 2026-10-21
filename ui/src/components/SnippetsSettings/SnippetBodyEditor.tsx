// Body field of the snippet editor: a small Monaco editor in the snippet's SQL dialect (lazy chunk, so the settings
// dialog opens without Monaco). Until it has loaded, and under the unit tests (jsdom), a textarea with the same
// props stands in.
import { lazy, Suspense } from 'react';
import type { Dialect } from '../../api/types';
import type { EffectiveTheme } from '../../theme/useTheme';

export interface SnippetBodyEditorProps {
  value: string;
  onChange(value: string): void;
  dialect: Dialect;
  theme: EffectiveTheme;
  ariaLabel: string;
  invalid: boolean;
  /** id(s) of the help/error text (aria-describedby). */
  describedBy: string;
}

const MonacoBodyEditor = lazy(() => import('./monacoBodyEditor'));
const IS_TEST = import.meta.env.MODE === 'test';

function TextareaBody(p: SnippetBodyEditorProps) {
  return (
    <textarea
      aria-label={p.ariaLabel}
      className="input mono snip-textarea"
      rows={8}
      spellCheck={false}
      value={p.value}
      onChange={(e) => p.onChange(e.target.value)}
      aria-invalid={p.invalid}
      aria-describedby={p.describedBy}
    />
  );
}

export function SnippetBodyEditor(p: SnippetBodyEditorProps) {
  if (IS_TEST) return <TextareaBody {...p} />;
  return (
    <Suspense fallback={<TextareaBody {...p} />}>
      <MonacoBodyEditor {...p} />
    </Suspense>
  );
}
