// Hover (PLAN 4.9): markdown for tables, columns, aliases, CTEs, functions, variables, synonyms, operators.
import type { HoverInfo } from '../types';
import type { DialectSpec } from '../dialect/spec';
import type { CatalogIndex, ObjectEntry } from '../catalog/index';
import { objectTypeLabel } from '../catalog/binder';
import type { ColumnDef } from '../parse/statement-model';
import type { SymbolInfo } from './symbol';
import { functionDoc, paramsText, varDoc } from '../complete/completer';

const MAX_COLS = 25;

function fkOf(entry: ObjectEntry | null, col: string): string | null {
  if (!entry) return null;
  for (const e of entry.fksOut) {
    const i = e.fromCols.findIndex((c) => c.toUpperCase() === col.toUpperCase());
    if (i >= 0) return `${e.toSchema ? e.toSchema + '.' : ''}${e.toTable}.${e.toCols[i] ?? ''}`;
  }
  return null;
}

function columnTable(cols: ColumnDef[], entry: ObjectEntry | null): string {
  if (!cols.length) return '_no columns known_';
  const rows = cols.slice(0, MAX_COLS).map((c) => {
    const badges: string[] = [];
    if (c.isPk) badges.push('PK');
    const fk = fkOf(entry, c.name);
    if (fk) badges.push('FK');
    if (c.identity) badges.push('identity');
    return `| ${c.name} | ${c.type || ''}${c.nullable === false ? ' NOT NULL' : ''} | ${badges.join(' ')} |`;
  });
  const more = cols.length > MAX_COLS ? `\n\n… and ${cols.length - MAX_COLS} more` : '';
  return '| column | type | |\n|---|---|---|\n' + rows.join('\n') + more;
}

export function objectMarkdown(entry: ObjectEntry, spec: DialectSpec, synonym: ObjectEntry | null): string {
  const head = synonym
    ? `**synonym** \`${synonym.qualifiedName}\` → \`${entry.qualifiedName}\` (${objectTypeLabel(entry.type)})`
    : `\`${entry.qualifiedName}\` (${objectTypeLabel(entry.type)})`;
  const parts = [head];
  if (entry.obj.cm) parts.push(entry.obj.cm);
  if (entry.type === 'synonym' && entry.obj.target) parts.push(`→ ${entry.obj.target.s ? entry.obj.target.s + '.' : ''}${entry.obj.target.n}`);
  if (entry.isTabular || entry.obj.c?.length) parts.push(columnTable(entry.columns(), entry));
  if (entry.type === 'proc' || entry.type === 'func' || entry.type === 'tablefunc') {
    const ret = entry.params().find((p) => p[2] === 'return');
    parts.push('```sql\n' + `${entry.name}(${paramsText(entry.params(), spec)})${ret ? (spec.id === 'plsql' ? ' RETURN ' : ' RETURNS ') + ret[1] : ''}` + '\n```');
  }
  if (entry.type === 'package') {
    parts.push(entry.members().slice(0, 30).map((m) => `- ${m.k === 'func' ? 'function' : 'procedure'} \`${m.n}(${paramsText(m.p, spec)})\``).join('\n'));
  }
  if (entry.obj.st === 'INVALID') parts.push('⚠ **INVALID**');
  return parts.join('\n\n');
}

export function hoverFor(sym: SymbolInfo, spec: DialectSpec, index: CatalogIndex): HoverInfo | null {
  void index;
  switch (sym.kind) {
    case 'alias': {
      const src = sym.src;
      const cols = src.columns();
      const what = src.entry ? `\`${src.entry.qualifiedName}\` (${objectTypeLabel(src.entry.type)})` : src.cte ? `cte \`${src.cte.name}\`` : `\`${src.display}\``;
      const head = `alias \`${src.label}\` → ${what}, ${cols.length} column${cols.length === 1 ? '' : 's'}`;
      return { range: sym.range, markdown: head + '\n\n' + columnTable(cols, src.entry) };
    }
    case 'object': return { range: sym.range, markdown: objectMarkdown(sym.entry, spec, sym.synonym) };
    case 'column': {
      const c = sym.col;
      const badges: string[] = [];
      badges.push(c.nullable === false ? 'NOT NULL' : c.nullable ? 'NULL' : '');
      if (c.isPk) badges.push('[PK]');
      const fk = fkOf(sym.entry, c.name);
      if (fk) badges.push(`[FK → ${fk}]`);
      if (c.identity) badges.push('[identity]');
      if (c.computed) badges.push('[computed]');
      let md = `\`${sym.ownerName}.${c.name}\` ${c.type} ${badges.filter(Boolean).join(' ')}`.trim();
      if (c.comment) md += '\n\n' + c.comment;
      return { range: sym.range, markdown: md };
    }
    case 'cte': return { range: sym.range, markdown: `cte \`${sym.cte.name}\` (${sym.columns.map((c) => c.name).join(', ')})` };
    case 'var': return { range: sym.range, markdown: varDoc(sym.v) };
    case 'temp': return { range: sym.range, markdown: `${sym.t.kind === 'tempTable' ? 'temp table' : sym.t.kind === 'tableVar' ? 'table variable' : 'table (created in this script)'} \`${sym.t.name}\`\n\n${columnTable(sym.columns, null)}` };
    case 'function': return { range: sym.range, markdown: `**${sym.f.name}** — ${sym.f.category}\n\n${functionDoc(sym.f)}` };
    case 'member': {
      const lines = sym.members.map((m) => {
        const ret = m.p.find((p) => p[2] === 'return');
        return `${m.k === 'func' ? 'FUNCTION' : 'PROCEDURE'} ${sym.pkg.name}.${m.n}(${paramsText(m.p, spec)})${ret ? ' RETURN ' + ret[1] : ''}`;
      });
      return { range: sym.range, markdown: '```sql\n' + lines.join('\n') + '\n```' };
    }
    case 'schema': return { range: sym.range, markdown: `schema \`${sym.name}\` (${sym.count} objects)` };
    case 'operator': return { range: sym.range, markdown: `\`${sym.op.op}\` — ${sym.op.doc}` };
    case 'sequenceOp': return { range: sym.range, markdown: `\`${sym.seq.qualifiedName}.${sym.op}\` — ${sym.op === 'NEXTVAL' ? 'increments the sequence and returns the new value' : 'returns the current value of the sequence in this session'}` };
  }
}
