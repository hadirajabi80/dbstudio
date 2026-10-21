// Rendering of BSON values (docs/PLAN-M2.md 6.3 "List: expandable tree cards, type-coloured values, arrays and
// subdocuments collapsible"). Values are coloured by type with the theme's data tokens; typed scalars show the
// constructor mongosh would print (ObjectId('…'), ISODate, NumberLong…), dates also get a local-time tooltip.
import { ChevronDown, ChevronRight } from 'lucide-react';
import { useState, type ReactNode } from 'react';
import {
  base64Length, formatDouble, isoDate, objectIdTime, TYPE_LABEL, uuidOf, type BsonEntry, type BsonValue,
} from '../../mongo/bson';

function quote(s: string, max: number): string {
  const cut = s.length > max ? `${s.slice(0, max)}…` : s;
  return JSON.stringify(cut);
}

/** Inline value (no expansion). `max` cuts long strings. */
export function ValueText({ v, max = 300 }: { v: BsonValue; max?: number }): ReactNode {
  switch (v.t) {
    case 'string': return <span className="mg-v mg-v-string" title={v.v.length > max ? `${v.v.length.toLocaleString()} characters` : undefined}>{quote(v.v, max)}</span>;
    case 'int': return <span className="mg-v mg-v-num">{v.v}</span>;
    case 'double': return <span className="mg-v mg-v-num">{formatDouble(v.v)}</span>;
    case 'long': return <span className="mg-v mg-v-num"><span className="mg-v-fn">NumberLong(</span>{v.v}<span className="mg-v-fn">)</span></span>;
    case 'decimal': return <span className="mg-v mg-v-num"><span className="mg-v-fn">NumberDecimal(</span>'{v.v}'<span className="mg-v-fn">)</span></span>;
    case 'bool': return <span className="mg-v mg-v-bool">{String(v.v)}</span>;
    case 'null': return <span className="mg-v mg-v-null">null</span>;
    case 'undefined': return <span className="mg-v mg-v-null">undefined</span>;
    case 'objectId': {
      const t = objectIdTime(v.v);
      return <span className="mg-v mg-v-oid" title={t ? `Created ${t.toLocaleString()}` : undefined}><span className="mg-v-fn">ObjectId(</span>'{v.v}'<span className="mg-v-fn">)</span></span>;
    }
    case 'date': {
      const iso = isoDate(v.v);
      return <span className="mg-v mg-v-date" title={iso ? new Date(v.v).toLocaleString() : undefined}>{iso ?? `Date(${v.v})`}</span>;
    }
    case 'binData': {
      const u = uuidOf(v);
      if (u) return <span className="mg-v mg-v-oid"><span className="mg-v-fn">UUID(</span>'{u}'<span className="mg-v-fn">)</span></span>;
      return <span className="mg-v mg-v-bin" title={`subtype ${parseInt(v.sub, 16)}`}><span className="mg-v-fn">Binary(</span>{base64Length(v.v).toLocaleString()} bytes<span className="mg-v-fn">)</span></span>;
    }
    case 'regex': return <span className="mg-v mg-v-string">/{v.pattern}/{v.flags}</span>;
    case 'timestamp': return <span className="mg-v mg-v-date"><span className="mg-v-fn">Timestamp(</span>{v.ts}, {v.inc}<span className="mg-v-fn">)</span></span>;
    case 'minKey': return <span className="mg-v mg-v-null">MinKey</span>;
    case 'maxKey': return <span className="mg-v mg-v-null">MaxKey</span>;
    case 'symbol': return <span className="mg-v mg-v-string">Symbol({quote(v.v, max)})</span>;
    case 'javascript': return <span className="mg-v mg-v-fnbody"><span className="mg-v-fn">Code(</span>{quote(v.v, 80)}<span className="mg-v-fn">)</span></span>;
    case 'dbPointer': return <span className="mg-v mg-v-oid">DBPointer('{v.ref}', '{v.id}')</span>;
    case 'trunc': return (
      <span className="mg-v mg-v-string mg-v-trunc" title={`Truncated: ${v.len.toLocaleString()} ${v.binary ? 'bytes' : 'characters'}`}>
        {v.binary ? `Binary(${v.len.toLocaleString()} bytes)` : quote(v.preview, Math.min(max, 200))}
        <span className="mg-trunc-badge">{v.len.toLocaleString()} {v.binary ? 'bytes' : 'chars'}</span>
      </span>
    );
    case 'array': return <span className="mg-v mg-v-meta">Array ({v.v.length})</span>;
    case 'object': return <span className="mg-v mg-v-meta">Object ({v.v.length} {v.v.length === 1 ? 'field' : 'fields'})</span>;
  }
}

export function typeOf(v: BsonValue): string {
  return TYPE_LABEL[v.t];
}

interface NodeProps {
  name: string;
  value: BsonValue;
  depth: number;
  /** Expand containers by default at this depth or shallower. */
  openDepth: number;
  isIndex?: boolean;
}

function FieldNode({ name, value, depth, openDepth, isIndex }: NodeProps) {
  const container = value.t === 'array' || value.t === 'object';
  const [open, setOpen] = useState(container && depth < openDepth);
  const children: BsonEntry[] = value.t === 'object' ? value.v : value.t === 'array' ? value.v.map((x, i) => [String(i), x] as BsonEntry) : [];
  return (
    <>
      <div className="mg-field" style={{ paddingLeft: depth * 16 }} role="treeitem" aria-level={depth + 1} aria-expanded={container ? open : undefined}>
        {container ? (
          <button className="mg-twisty" aria-label={open ? `Collapse ${name}` : `Expand ${name}`} onClick={() => setOpen(!open)} tabIndex={-1}>
            {open ? <ChevronDown size={14} aria-hidden /> : <ChevronRight size={14} aria-hidden />}
          </button>
        ) : <span className="mg-twisty-pad" />}
        <span className={isIndex ? 'mg-key mg-key-index' : 'mg-key'}>{name}</span>
        <span className="mg-colon">:</span>
        <span className="mg-val" onDoubleClick={container ? () => setOpen(!open) : undefined}><ValueText v={value} /></span>
      </div>
      {open && children.map(([k, x]) => <FieldNode key={k} name={k} value={x} depth={depth + 1} openDepth={openDepth} isIndex={value.t === 'array'} />)}
    </>
  );
}

/** A document as an expandable field tree; shows `maxFields` top-level fields until "Show more". */
export function DocTree({ doc, maxFields = 15, openDepth = 0 }: { doc: BsonValue; maxFields?: number; openDepth?: number }) {
  const [all, setAll] = useState(false);
  const entries = doc.t === 'object' ? doc.v : [];
  const shown = all ? entries : entries.slice(0, maxFields);
  return (
    <div className="mg-tree" role="tree">
      {shown.map(([k, v]) => <FieldNode key={k} name={k} value={v} depth={0} openDepth={openDepth} />)}
      {entries.length > shown.length && (
        <button className="link-btn mg-more" onClick={() => setAll(true)}>Show {entries.length - shown.length} more fields</button>
      )}
      {all && entries.length > maxFields && <button className="link-btn mg-more" onClick={() => setAll(false)}>Show fewer fields</button>}
    </div>
  );
}
