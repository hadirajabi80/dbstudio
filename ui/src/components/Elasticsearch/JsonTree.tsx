// Expandable JSON tree (documents, mappings, settings, stats, aggregations): type-coloured values, collapsible objects
// and arrays, `dir="auto"` strings (Persian / Arabic text), highlight fragments rendered with <em>.
import { ChevronDown, ChevronRight } from 'lucide-react';
import { useState, type ReactNode } from 'react';

function Scalar({ v }: { v: unknown }): ReactNode {
  if (v === null) return <span className="es-v es-v-null">null</span>;
  if (typeof v === 'string') return <span className="es-v es-v-string" dir="auto">{JSON.stringify(v)}</span>;
  if (typeof v === 'number') return <span className="es-v es-v-num">{String(v)}</span>;
  if (typeof v === 'boolean') return <span className="es-v es-v-bool">{String(v)}</span>;
  return <span className="es-v">{String(v)}</span>;
}

/** Inline value for grid cells: strings bare, containers as {n} / [n]. */
export function CellValue({ v }: { v: unknown }): ReactNode {
  if (v === undefined) return <span className="es-v-missing">—</span>;
  if (v === null) return <span className="es-v es-v-null">null</span>;
  if (typeof v === 'string') return <span className="es-v es-v-string-bare" dir="auto">{v.length > 200 ? `${v.slice(0, 200)}…` : v}</span>;
  if (typeof v === 'number') return <span className="es-v es-v-num">{String(v)}</span>;
  if (typeof v === 'boolean') return <span className="es-v es-v-bool">{String(v)}</span>;
  if (Array.isArray(v)) {
    if (v.every((x) => typeof x === 'string' || typeof x === 'number') && v.length <= 6) {
      return <span className="es-v es-v-arr">{v.map((x, i) => <span key={i} className="es-chip">{String(x)}</span>)}</span>;
    }
    return <span className="es-v es-v-meta">[{v.length}]</span>;
  }
  return <span className="es-v es-v-meta">{'{'}{Object.keys(v as object).length}{'}'}</span>;
}

function Node({ name, value, depth, openDepth, isIndex }: { name: string; value: unknown; depth: number; openDepth: number; isIndex?: boolean }) {
  const container = !!value && typeof value === 'object';
  const [open, setOpen] = useState(container && depth < openDepth);
  const entries: [string, unknown][] = Array.isArray(value) ? value.map((x, i) => [String(i), x]) : container ? Object.entries(value as object) : [];
  const summary = Array.isArray(value) ? `[${value.length}]` : container ? `{${entries.length}}` : null;
  return (
    <>
      <div className="es-jt-row" style={{ paddingLeft: depth * 16 }} role="treeitem" aria-level={depth + 1} aria-expanded={container ? open : undefined}>
        {container ? (
          <button type="button" className="es-jt-twisty" aria-label={open ? `Collapse ${name}` : `Expand ${name}`} onClick={() => setOpen(!open)} tabIndex={-1}>
            {open ? <ChevronDown size={13} aria-hidden /> : <ChevronRight size={13} aria-hidden />}
          </button>
        ) : <span className="es-jt-pad" />}
        <span className={isIndex ? 'es-jt-key es-jt-index' : 'es-jt-key'} dir="auto">{name}</span>
        <span className="es-jt-colon">:</span>
        {container ? (
          <button type="button" className="es-jt-summary" onClick={() => setOpen(!open)} tabIndex={-1}>{summary}</button>
        ) : <span className="es-jt-val"><Scalar v={value} /></span>}
      </div>
      {open && entries.map(([k, x]) => <Node key={k} name={k} value={x} depth={depth + 1} openDepth={openDepth} isIndex={Array.isArray(value)} />)}
    </>
  );
}

/** A JSON value as a tree; the root's members are the first level. */
export function JsonTree({ value, openDepth = 1, label = 'JSON' }: { value: unknown; openDepth?: number; label?: string }) {
  if (value === undefined) return <div className="es-empty">No value</div>;
  if (!value || typeof value !== 'object') return <div className="es-jt" role="tree" aria-label={label}><Scalar v={value} /></div>;
  const entries: [string, unknown][] = Array.isArray(value) ? value.map((x, i) => [String(i), x]) : Object.entries(value as object);
  return (
    <div className="es-jt" role="tree" aria-label={label}>
      {entries.length === 0 && <span className="muted">{Array.isArray(value) ? '[ ]' : '{ }'}</span>}
      {entries.map(([k, v]) => <Node key={k} name={k} value={v} depth={0} openDepth={openDepth} isIndex={Array.isArray(value)} />)}
    </div>
  );
}

/** Highlight fragment (`<em>…</em>` from Elasticsearch) as React nodes; everything else is text. */
export function Fragment({ html }: { html: string }) {
  const parts = html.split(/(<em>.*?<\/em>)/g);
  return (
    <span dir="auto">
      {parts.map((p, i) => (p.startsWith('<em>') ? <mark key={i} className="es-hl">{p.slice(4, -5)}</mark> : <span key={i}>{p}</span>))}
    </span>
  );
}
