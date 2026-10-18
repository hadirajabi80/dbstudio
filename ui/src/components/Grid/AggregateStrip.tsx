// Status-row summary of a multi-cell selection (prop-01): Count · Sum · Avg · Min · Max, or distinct N for text.
// Each value is a button that copies the raw number.
import { copyText } from '../../app/actions';
import { formatCount } from '../../lib/format';
import { groupDigits, type SelectionAggregates } from './aggregate';

export function AggregateStrip({ agg, partial }: { agg: SelectionAggregates | null; partial?: boolean }) {
  if (!agg || agg.cells < 2) return null;
  const items: { label: string; shown: string; raw: string }[] = [{ label: 'Count', shown: formatCount(agg.count), raw: String(agg.count) }];
  if (agg.numeric > 0) {
    for (const [label, v] of [['Sum', agg.sum], ['Avg', agg.avg], ['Min', agg.min], ['Max', agg.max]] as const) {
      if (v !== null) items.push({ label, shown: groupDigits(v), raw: v });
    }
  }
  if (agg.distinct !== null) items.push({ label: 'Distinct', shown: formatCount(agg.distinct), raw: String(agg.distinct) });
  return (
    <span className="rs-agg" role="group" aria-label="Selection summary">
      {items.map((it) => (
        <button
          key={it.label}
          type="button"
          className="rs-agg-item"
          title={`Copy ${it.label.toLowerCase()}: ${it.raw}`}
          onClick={() => void copyText(it.raw, `Copied ${it.label.toLowerCase()} ${it.raw}`)}
        >
          <span className="rs-agg-label">{it.label}</span> {it.shown}
        </button>
      ))}
      {partial && <span className="rs-agg-note" title="More rows exist than are loaded; the summary covers the loaded rows">of loaded rows</span>}
    </span>
  );
}
