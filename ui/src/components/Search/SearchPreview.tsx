// The Find in database dialog's preview: the definition (DDL) of the selected match's object around the match, every
// occurrence of the search text highlighted and the matched line marked; a data match shows its value and row key.
import { KeyRound, LoaderCircle, Rows3, TriangleAlert } from 'lucide-react';
import { useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import { errorMessage } from '../../api/client';
import { OBJECT_TYPE_SINGULAR } from '../../lib/sql';
import { ObjectIcon } from '../common/icons';
import { Marked } from './Marked';
import { findMatches, focusLine, keyLabel, segments, type MatchOptions, type ObjectGroup, type ResultRow } from './model';
import { fetchDdl, hasDdl } from './previewCache';

/** Lines shown before / after the matched line. */
const BEFORE = 40;
const AFTER = 120;
const FETCH_DELAY_MS = 120;

function objectOf(row: ResultRow | null): ObjectGroup | null {
  if (!row) return null;
  if (row.kind === 'object') return row.group;
  if (row.kind === 'hit') return row.object;
  return null;
}

export function SearchPreview({ row, options }: { row: ResultRow | null; options: MatchOptions }) {
  const object = objectOf(row);
  const dataHit = row?.kind === 'hit' && row.hit.match === 'data' ? row.hit : null;
  const [ddl, setDdl] = useState<{ key: string; text: string | null; error: string | null } | null>(null);
  const objectKey = object && !dataHit ? object.key : null;

  useEffect(() => {
    if (!object || !objectKey) return;
    if (ddl?.key === objectKey) return;
    let cancelled = false;
    const t = setTimeout(() => {
      fetchDdl(object)
        .then((text) => { if (!cancelled) setDdl({ key: objectKey, text, error: null }); })
        .catch((e) => { if (!cancelled) setDdl({ key: objectKey, text: null, error: errorMessage(e) }); });
    }, hasDdl(objectKey) ? 0 : FETCH_DELAY_MS);
    return () => {
      cancelled = true;
      clearTimeout(t);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [objectKey]);

  const current = ddl && ddl.key === objectKey ? ddl : null;
  const lines = useMemo(() => (current?.text ?? '').replace(/\r\n?/g, '\n').split('\n'), [current?.text]);
  const focus = row && current?.text ? focusLine(lines, row, options) : -1;
  const bodyRef = useRef<HTMLDivElement>(null);
  const from = Math.max(0, focus - BEFORE);
  const to = Math.min(lines.length, focus + AFTER);

  // Keep the matched line in view, a third from the top.
  useLayoutEffect(() => {
    const el = bodyRef.current;
    const line = el?.querySelector<HTMLElement>('.sx-pv-line.focus');
    if (!el || !line) return;
    el.scrollTop = Math.max(0, line.offsetTop - Math.floor(el.clientHeight / 3));
    el.scrollLeft = 0;
  }, [focus, objectKey]);

  let content;
  if (!row || (!object && row.kind !== 'error')) {
    content = <div className="sx-pv-empty">Select a match to preview it</div>;
  } else if (row.kind === 'error') {
    content = <div className="sx-pv-empty">{row.error.message}</div>;
  } else if (dataHit) {
    content = (
      <dl className="sx-pv-data">
        <dt><Rows3 size={13} aria-hidden="true" /> {dataHit.column}</dt>
        <dd className="mono"><Marked text={dataHit.text} ranges={dataHit.ranges} /></dd>
        {dataHit.key?.length ? (
          <>
            <dt><KeyRound size={13} aria-hidden="true" /> Row</dt>
            <dd className="mono">{keyLabel(dataHit.key)}</dd>
          </>
        ) : null}
      </dl>
    );
  } else if (!current) {
    content = <div className="sx-pv-empty"><LoaderCircle size={14} className="spin" aria-hidden="true" /> Loading the definition…</div>;
  } else if (current.error) {
    content = <div className="sx-pv-empty sx-danger"><TriangleAlert size={14} aria-hidden="true" /> {current.error}</div>;
  } else {
    content = (
      <pre className="sx-pv-code mono">
        {lines.slice(from, to).map((l, j) => {
          const i = from + j;
          return (
            <div key={i} className={`sx-pv-line${i === focus ? ' focus' : ''}`}>
              <span className="sx-pv-no" aria-hidden="true">{i + 1}</span>
              <span className="sx-pv-text">
                {segments(l, findMatches(l, options)).map((s, k) => (s.hit ? <mark key={k}>{s.text}</mark> : <span key={k}>{s.text}</span>))}
                {l === '' ? ' ' : null}
              </span>
            </div>
          );
        })}
      </pre>
    );
  }

  return (
    <section className="sx-preview" aria-label="Preview">
      <header className="sx-pv-head">
        {object ? (
          <>
            <ObjectIcon type={object.type} size={14} />
            <span className="sx-pv-name mono">{object.schema ? `${object.schema}.` : ''}{object.name}</span>
            <span className="sx-muted">{OBJECT_TYPE_SINGULAR[object.type] ?? object.type}</span>
            {focus >= 0 && !dataHit && <span className="sx-muted sx-pv-at">line {focus + 1}</span>}
          </>
        ) : (
          <span className="sx-muted">Preview</span>
        )}
      </header>
      <div className="sx-pv-body" ref={bodyRef}>{content}</div>
    </section>
  );
}
