// DDL preview text <-> statement list. The preview shows the engine's script as a runnable document; when the user
// edits it by hand, Apply re-splits the text with the IntelliSense splitter and sends it verbatim. Pure TypeScript.
import type { DdlScript, DdlStatement, Dialect } from '../api/types';
import { getSpec } from '../intel/dialect';
import { tokenize } from '../intel/lexer/lexer';
import { splitStatements } from '../intel/split/splitter';

const ORACLE_BLOCK = /^\s*(BEGIN|DECLARE|CREATE\s+(OR\s+REPLACE\s+)?(EDITIONABLE\s+|NONEDITIONABLE\s+)?(TRIGGER|PROCEDURE|FUNCTION|PACKAGE|TYPE\s+BODY|TYPE))\b/i;

/** One statement as it appears in the preview document. */
function terminate(sql: string, dialect: Dialect): string {
  const s = sql.trim();
  if (dialect === 'plsql') return ORACLE_BLOCK.test(s) ? `${s.replace(/;?\s*$/, ';')}\n/` : `${s.replace(/;\s*$/, '')};`;
  if (dialect === 'tsql') return s.replace(/;\s*$/, '') + ';';
  return /;\s*$/.test(s) ? s : `${s};`;
}

export interface PreviewText {
  text: string;
  /** 1-based first line of each statement in `text`. */
  lines: number[];
}

/** Statements → document: T-SQL batches separated by GO, Oracle blocks closed by `/`, everything else by `;`. */
export function scriptToText(statements: Pick<DdlStatement, 'sql' | 'warning'>[], dialect: Dialect): PreviewText {
  const parts: string[] = [];
  const lines: number[] = [];
  let line = 1;
  statements.forEach((s, i) => {
    const comment = s.warning ? `-- ⚠ ${s.warning.replace(/\s+/g, ' ')}\n` : '';
    const body = terminate(s.sql, dialect);
    const block = `${comment}${body}${dialect === 'tsql' && i < statements.length - 1 ? '\nGO' : ''}`;
    lines.push(line + (comment ? 1 : 0));
    parts.push(block);
    line += block.split('\n').length + 1;
  });
  return { text: parts.join('\n\n') + (parts.length ? '\n' : ''), lines };
}

export interface SplitStatement {
  sql: string;
  /** 1-based line of the statement in the document. */
  line: number;
}

/** Document → statements for POST .../designer/apply (T-SQL: GO batches; others: statements). */
export function splitForApply(text: string, dialect: Dialect): SplitStatement[] {
  const spec = getSpec(dialect);
  const toks = tokenize(text, spec);
  const split = splitStatements(toks, text, spec, { blankLineSplitsStatements: false });
  const lineOf = (offset: number) => text.slice(0, offset).split('\n').length;
  const out: SplitStatement[] = [];
  if (dialect === 'tsql') {
    for (const b of split.batches) {
      const raw = text.slice(b.start, b.end);
      const sql = stripComments(raw, dialect).trim() ? raw.trim() : '';
      if (!sql) continue;
      const lead = raw.length - raw.trimStart().length;
      for (let i = 0; i < Math.max(1, b.repeat); i++) out.push({ sql, line: lineOf(b.start + lead) });
    }
    return out;
  }
  for (const st of split.statements) {
    if (st.kind === 'empty' || st.skipOnRun) continue;
    const sql = (st.execText ?? st.text).trim();
    if (!stripComments(sql, dialect).trim()) continue;
    out.push({ sql, line: st.line });
  }
  return out;
}

function stripComments(sql: string, dialect: Dialect): string {
  return tokenize(sql, getSpec(dialect))
    .filter((t) => t.kind !== 'comment' && t.kind !== 'ws' && t.kind !== 'eof')
    .map((t) => t.text)
    .join(' ');
}

/** Banner text describing how a script is applied. */
export function applySummary(script: Pick<DdlScript, 'statements' | 'transactional' | 'rebuildRequired'>, dialect: Dialect): string {
  const n = script.statements.length;
  const count = `${n} statement${n === 1 ? '' : 's'}`;
  if (!n) return 'No changes';
  if (script.rebuildRequired) return `${count} · table rebuild (copy, drop, rename) in one transaction`;
  if (script.transactional) return `${count} · runs in one transaction`;
  return dialect === 'plsql' ? `${count} · each DDL statement commits on its own; stops at the first error` : `${count} · runs statement by statement`;
}
