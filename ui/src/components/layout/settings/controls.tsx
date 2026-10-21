// Building blocks of the Settings sections: cards that group rows, rows (label + hint on the left, the control on
// the right), toggle rows, and the small Select / number helpers. Rows hide themselves when the settings search does
// not match their label, hint or keywords; a card or section without visible rows hides via CSS (settings.css).
import { useContext, type ReactNode } from 'react';
import { Select as StyledSelect } from '../../common/Select';
import { matchesQuery, SettingsQuery } from './search';

export function Card({ title, description, children, className }: { title: string; description?: ReactNode; children: ReactNode; className?: string }) {
  return (
    <section className={`settings-card${className ? ` ${className}` : ''}`} aria-label={title}>
      <header className="settings-card-head">
        <h3 className="settings-card-title">{title}</h3>
        {description && <p className="settings-card-desc">{description}</p>}
      </header>
      <div className="settings-card-body">{children}</div>
    </section>
  );
}

interface RowProps {
  label: string;
  htmlFor?: string;
  hint?: ReactNode;
  /** Extra search words. */
  keywords?: string;
  /** Control below the label (wide controls: pickers). */
  stacked?: boolean;
  /** The label only names the row for search and assistive tech (the control has its own headings). */
  labelHidden?: boolean;
  children: ReactNode;
}

export function Row({ label, htmlFor, hint, keywords, stacked, labelHidden, children }: RowProps) {
  const query = useContext(SettingsQuery);
  const visible = matchesQuery(query, label, typeof hint === 'string' ? hint : undefined, keywords);
  return (
    <div className={`settings-row${stacked ? ' stacked' : ''}`} hidden={!visible} data-settings-row="">
      <div className={`settings-label${labelHidden ? ' sr-only' : ''}`}>
        <label htmlFor={htmlFor}>{label}</label>
        {hint && <span className="settings-hint">{hint}</span>}
      </div>
      <div className="settings-control">{children}</div>
    </div>
  );
}

/** Free-form card content that takes part in the search like a row (hidden unless `keywords` match). */
export function SearchBlock({ keywords, className, children }: { keywords: string; className?: string; children: ReactNode }) {
  const query = useContext(SettingsQuery);
  return (
    <div className={className} hidden={!matchesQuery(query, keywords)} data-settings-row="">
      {children}
    </div>
  );
}

/** A setting that is on or off: the label (its accessible name) on the left, a switch-styled checkbox on the right. */
export function ToggleRow({ id, label, hint, keywords, checked, onChange }: {
  id: string; label: string; hint?: ReactNode; keywords?: string; checked: boolean; onChange: (v: boolean) => void;
}) {
  return (
    <Row label={label} htmlFor={id} hint={hint} keywords={keywords}>
      <input id={id} type="checkbox" className="settings-switch" checked={checked} onChange={(e) => onChange(e.target.checked)} />
    </Row>
  );
}

export function Select<T extends string>({ id, value, options, onChange }: { id: string; value: T; options: [T, string][]; onChange: (v: T) => void }) {
  return <StyledSelect id={id} value={value} options={options.map(([v, l]) => ({ value: v, label: l }))} onChange={onChange} />;
}

export function Num({ id, value, min, max, onChange }: { id: string; value: number; min: number; max: number; onChange: (v: number) => void }) {
  return (
    <input
      id={id}
      type="number"
      className="input settings-num"
      value={value}
      min={min}
      max={max}
      onChange={(e) => {
        const n = Number(e.target.value);
        if (Number.isFinite(n) && n >= min && n <= max) onChange(n);
      }}
    />
  );
}

/** Segmented choice (a radiogroup of small buttons). */
export function Segmented<T extends string>({ label, value, options, onChange }: { label: string; value: T; options: { value: T; label: string; icon?: ReactNode }[]; onChange: (v: T) => void }) {
  return (
    <div className="segmented settings-segmented" role="radiogroup" aria-label={label}>
      {options.map((o) => (
        <button key={o.value} type="button" role="radio" aria-checked={value === o.value} className={value === o.value ? 'on' : ''} onClick={() => onChange(o.value)}>
          {o.icon}
          {o.label}
        </button>
      ))}
    </div>
  );
}
