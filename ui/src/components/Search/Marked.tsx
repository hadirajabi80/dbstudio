import type { SearchHitItem } from '../../api/types.search';
import { segments } from './model';

/** Text with its matched ranges in <mark>. */
export function Marked({ text, ranges }: { text: string; ranges: SearchHitItem['ranges'] | null | undefined }) {
  return (
    <>
      {segments(text, ranges).map((s, i) => (s.hit ? <mark key={i}>{s.text}</mark> : <span key={i}>{s.text}</span>))}
    </>
  );
}
