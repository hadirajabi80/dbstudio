// What the "Rebuild the table?" / "Drop columns or constraints?" confirmation lists (pure): the destructive
// statements as SQL first lines, the scripter's annotations as notes (muted prose, not red SQL), and the dependent
// objects a SQLite rebuild drops and recreates.
import type { DdlStatement } from '../../api/types';
import type { ConfirmItem } from '../../components/common/ConfirmDialog';
import { pluralize } from '../../components/common/text';

/** Statements the confirmation lists: drops, rebuild steps and every statement carrying a warning. */
export function confirmItems(statements: readonly Pick<DdlStatement, 'sql' | 'kind' | 'warning'>[]): ConfirmItem[] {
  const out: ConfirmItem[] = [];
  for (const s of statements) {
    if (s.kind !== 'drop' && s.kind !== 'rebuild' && !s.warning) continue;
    out.push({ text: s.sql.trim().split('\n')[0], kind: 'sql' });
    if (s.warning) out.push({ text: s.warning, kind: 'note' });
  }
  return out;
}

const unquote = (n: string) => n.replace(/^(["`[])(.*)(["`\]])$/, '$2').replace(/""/g, '"');

/** The object name of a CREATE statement: the last part of a (possibly quoted, qualified) name. */
function createdName(sql: string, kind: 'VIEW' | 'TRIGGER' | 'INDEX'): string | null {
  const name = String.raw`(?:"(?:[^"]|"")+"|\[[^\]]+\]|` + '`[^`]+`' + String.raw`|[\w$#]+)`;
  const re = new RegExp(
    String.raw`^\s*CREATE\s+(?:OR\s+(?:REPLACE|ALTER)\s+)?(?:TEMP(?:ORARY)?\s+)?(?:UNIQUE\s+)?${kind}\s+(?:IF\s+NOT\s+EXISTS\s+)?(?:${name}\s*\.\s*)?(${name})`,
    'i',
  );
  const m = re.exec(sql);
  return m ? unquote(m[1]) : null;
}

/**
 * Dependent objects the script recreates, e.g. "Views recreated: CustomerOrderTotals. Triggers recreated: 2.
 * Indexes recreated: 1." Views are named (they are what users lose sight of); triggers and indexes are counted.
 * Empty when the script recreates nothing.
 */
export function recreatedSummary(statements: readonly Pick<DdlStatement, 'sql'>[]): string {
  const views: string[] = [];
  let triggers = 0;
  let indexes = 0;
  for (const s of statements) {
    const v = createdName(s.sql, 'VIEW');
    if (v) { views.push(v); continue; }
    if (createdName(s.sql, 'TRIGGER')) triggers++;
    else if (createdName(s.sql, 'INDEX')) indexes++;
  }
  const parts: string[] = [];
  if (views.length) parts.push(`${views.length === 1 ? 'View' : 'Views'} recreated: ${views.join(', ')}.`);
  if (triggers) parts.push(`${pluralize(triggers, 'trigger')} recreated.`);
  if (indexes) parts.push(`${pluralize(indexes, 'index', 'indexes')} recreated.`);
  return parts.join(' ');
}
