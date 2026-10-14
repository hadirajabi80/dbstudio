// Object DDL tab "Formatted" toggle (PLAN-M1.5 1.2): a non-destructive formatted view of stored DDL. The initial
// state follows Settings.format.formatDdlOnOpen (default true). Wiring in ObjectTab (WP-I):
//
//   const f = useFormattedDdl(ddl?.ddl ?? null, dialect);   // from ./formatted-ddl (or editor/index)
//   <FormattedToggle {...f.toggle} />            // in the header / section bar
//   <SqlEditor value={f.text} readOnly … />      // instead of ddl.ddl ("DDL in console" can keep ddl.ddl)
import { WandSparkles } from 'lucide-react';
import type { FormattedToggleProps } from './formatted-ddl';

export type { FormattedDdl, FormattedToggleProps } from './formatted-ddl';

export function FormattedToggle({ pressed, onChange, warnings, disabled }: FormattedToggleProps) {
  const title = pressed
    ? warnings ? `Formatted view (${warnings} statement${warnings === 1 ? '' : 's'} shown as stored). Click to show the stored text.` : 'Formatted view. Click to show the stored text.'
    : 'Showing the stored text. Click to format it (the object is not changed).';
  return (
    <button type="button" className={`btn btn-xs${pressed ? ' active' : ''}`} aria-pressed={pressed} disabled={disabled} title={title} onClick={() => onChange(!pressed)}>
      <WandSparkles size={12} aria-hidden /> Formatted
    </button>
  );
}
