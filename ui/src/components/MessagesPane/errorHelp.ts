// Error guidance for the Messages pane (design-22 / design-p8): common driver errors become one plain sentence plus
// an action, and an unknown table or column gets a "Did you mean …?" suggestion from the loaded catalog.
import { useCatalog } from '../../store/catalog';
import { suggestIdentifier } from '../../editor/markers-core';

export type UnknownKind = 'table' | 'column';

export interface UnknownIdentifier {
  kind: UnknownKind;
  /** As written in the statement (last part of a qualified name, quotes removed). */
  name: string;
}

function unquote(raw: string): string {
  const last = raw.split('.').pop() ?? raw;
  return last.replace(/^[[\]"`']+|[[\]"`']+$/g, '');
}

/** The identifier an "unknown table / column" error is about (SQLite, SQL Server, Oracle wording). */
export function unknownIdentifier(text: string): UnknownIdentifier | null {
  let m = /no such table:\s*([\w$#.[\]"`]+)/i.exec(text) ?? /Invalid object name '([^']+)'/i.exec(text);
  if (m) return { kind: 'table', name: unquote(m[1]) };
  m = /no such column:\s*([\w$#.[\]"`]+)/i.exec(text) ?? /Invalid column name '([^']+)'/i.exec(text) ?? /ORA-00904:\s*("?[\w$#]+"?(?:\."?[\w$#]+"?)?)\s*: invalid identifier/i.exec(text);
  if (m) return { kind: 'column', name: unquote(m[1]) };
  return null;
}

export interface ErrorHelp {
  /** One sentence that says what happened and what to do. */
  sentence: string;
  /** Optional one-click action. */
  action?: { label: string; command: string };
}

/** Guidance the engine puts in its own lock-wait message (engine LockWait.Describe, with or without a known holder). */
const LOCK_WAIT_GUIDANCE = /Commit or roll back there|Wait for it to finish \(or end its transaction\)/i;

/**
 * Plain-language guidance for common errors; null when there is nothing better to say than the driver text. The
 * sentence is empty when the message already says it and only the action is worth adding.
 */
export function errorHelp(code: string | null, text: string): ErrorHelp | null {
  const t = text;
  const u = unknownIdentifier(t);
  if (u?.kind === 'table') return { sentence: `There is no table or view named “${u.name}” on this connection.` };
  if (u?.kind === 'column') return { sentence: `None of the tables in this statement has a column named “${u.name}”.` };
  if (/ORA-00942/i.test(t)) return { sentence: 'The table or view does not exist, or your login cannot see it.' };
  if (code === 'READ_ONLY') return { sentence: 'This connection is read-only, so statements that change data are refused.', action: { label: 'Connection settings', command: 'connections.edit' } };
  if (/database is locked|SQLITE_BUSY|deadlock|lock request time ?out|ORA-00054|ORA-00060/i.test(t)) {
    const showSessions = { label: 'Show sessions', command: 'connections.showActive' };
    // The engine's lock-wait text (LockWait.Describe) already names the holder and says what to do: offer only the
    // action, so the guidance is not repeated under it (design-r1-06).
    if (LOCK_WAIT_GUIDANCE.test(t)) return { sentence: '', action: showSessions };
    return { sentence: 'Another session holds a lock on this data. Commit or roll back that session, then run again.', action: showSessions };
  }
  if (/time ?out|timed out|ORA-01013/i.test(t) || code === 'TIMEOUT') {
    return { sentence: 'The statement ran longer than the command timeout. Narrow the query, or raise the timeout in the connection settings.' };
  }
  if (/permission|access is denied|denied|not authori[sz]ed|ORA-01031|ORA-01017/i.test(t)) {
    return { sentence: 'Your login does not have permission for this statement.' };
  }
  const near = /near\s+["'“]?([^"'”:]+?)["'”]?\s*:\s*syntax error/i.exec(t) ?? /Incorrect syntax near (?:the keyword )?'([^']+)'/i.exec(t);
  if (near) return { sentence: `Syntax error near “${near[1]}”. Check the statement around the marked line.` };
  if (/syntax error|ORA-00933|ORA-00936|ORA-00907/i.test(t)) return { sentence: 'The statement has a syntax error. Check the marked line.' };
  return null;
}

/** Object or column names of a connection's loaded catalog (all databases/schemas), for suggestions. */
export function catalogNames(connectionId: string, kind: UnknownKind, sql?: string): string[] {
  const out = new Set<string>();
  const dbs = Object.values(useCatalog.getState().dbs).filter((d) => d.connectionId === connectionId);
  const words = sql ? new Set(sql.toLowerCase().match(/[\w$#]+/g) ?? []) : null;
  for (const d of dbs) {
    for (const s of Object.values(d.loaded)) {
      for (const o of s.objects) {
        if (kind === 'table') {
          if (['table', 'view', 'mview', 'synonym', 'tablefunc'].includes(o.t)) out.add(o.n);
        } else if (o.c && (!words || words.has(o.n.toLowerCase()))) {
          for (const c of o.c) out.add(c[0]);
        }
      }
    }
  }
  // Columns: when the statement names no loaded table, fall back to every column.
  if (kind === 'column' && words && out.size === 0) return catalogNames(connectionId, kind);
  return [...out];
}

/** "Did you mean …" for an error message of an execution on `connectionId` (null when nothing is close). */
export function didYouMean(connectionId: string, text: string, sql?: string): { kind: UnknownKind; name: string; suggestion: string } | null {
  const u = unknownIdentifier(text);
  if (!u) return null;
  const suggestion = suggestIdentifier(u.name, catalogNames(connectionId, u.kind, sql));
  return suggestion ? { ...u, suggestion } : null;
}

function escapeRe(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/**
 * Replace `name` with `replacement` in `text`: the first whole-word occurrence on `line` (1-based) when given and
 * present there, else the first one in the document. Returns null when the name does not occur.
 */
export function replaceIdentifier(text: string, name: string, replacement: string, line: number | null): string | null {
  const re = new RegExp(`(^|[^\\w$#])(${escapeRe(name)})(?![\\w$#])`, 'i');
  const lines = text.split('\n');
  if (line !== null && line >= 1 && line <= lines.length) {
    const m = re.exec(lines[line - 1]);
    if (m) {
      const at = m.index + m[1].length;
      lines[line - 1] = lines[line - 1].slice(0, at) + replacement + lines[line - 1].slice(at + m[2].length);
      return lines.join('\n');
    }
  }
  const m = re.exec(text);
  if (!m) return null;
  const at = m.index + m[1].length;
  return text.slice(0, at) + replacement + text.slice(at + m[2].length);
}
