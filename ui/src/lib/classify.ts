import type { Dialect, SqlBatch } from '../api/types';

/**
 * Small, dialect-tolerant classifier for the destructive-statement guard (TablePlus "safe mode").
 * Flags DROP, TRUNCATE, ALTER ... DROP, and UPDATE/DELETE without a WHERE clause at the statement's depth.
 * Comments, strings and quoted identifiers are skipped so `-- DELETE FROM x` or 'DROP' never trigger.
 */
export type DestructiveKind = 'DROP' | 'TRUNCATE' | 'DELETE' | 'UPDATE' | 'ALTER_DROP';

export interface DestructiveFinding {
  kind: DestructiveKind;
  /** Short human description, e.g. "DELETE without WHERE on Orders". */
  description: string;
  /** 1-based document line of the statement keyword. */
  line: number;
}

interface Tok {
  w: string; // upper-cased word or punctuation
  depth: number;
  line: number;
  raw: string;
}

function tokenize(sql: string, baseLine: number, dialect: Dialect): Tok[] {
  const out: Tok[] = [];
  let i = 0;
  let line = baseLine;
  let depth = 0;
  const n = sql.length;
  while (i < n) {
    const c = sql[i];
    if (c === '\n') { line++; i++; continue; }
    if (c === ' ' || c === '\t' || c === '\r') { i++; continue; }
    if (c === '-' && sql[i + 1] === '-') {
      while (i < n && sql[i] !== '\n') i++;
      continue;
    }
    if (c === '/' && sql[i + 1] === '*') {
      let nest = 1;
      i += 2;
      while (i < n && nest > 0) {
        if (sql[i] === '\n') line++;
        if (dialect === 'tsql' && sql[i] === '/' && sql[i + 1] === '*') { nest++; i += 2; continue; }
        if (sql[i] === '*' && sql[i + 1] === '/') { nest--; i += 2; continue; }
        i++;
      }
      continue;
    }
    if (c === "'" || c === '"' || c === '`' || (c === '[' && dialect !== 'plsql')) {
      const close = c === '[' ? ']' : c;
      const start = i;
      i++;
      while (i < n) {
        if (sql[i] === '\n') line++;
        if (sql[i] === close) {
          if (sql[i + 1] === close) { i += 2; continue; }
          i++;
          break;
        }
        i++;
      }
      const raw = sql.slice(start, i);
      out.push({ w: c === "'" ? "'STR'" : 'IDENT', depth, line, raw });
      continue;
    }
    if (c === '(') { out.push({ w: '(', depth, line, raw: c }); depth++; i++; continue; }
    if (c === ')') { depth = Math.max(0, depth - 1); out.push({ w: ')', depth, line, raw: c }); i++; continue; }
    if (c === ';') { out.push({ w: ';', depth, line, raw: c }); i++; continue; }
    if (/[A-Za-z_@#$]/.test(c)) {
      const start = i;
      while (i < n && /[A-Za-z0-9_@#$]/.test(sql[i])) i++;
      const raw = sql.slice(start, i);
      out.push({ w: raw.toUpperCase(), depth, line, raw });
      continue;
    }
    if (c === '.') { out.push({ w: '.', depth, line, raw: c }); i++; continue; }
    // other operators / numbers
    const start = i;
    i++;
    out.push({ w: sql.slice(start, i), depth, line, raw: sql.slice(start, i) });
  }
  return out;
}

const STATEMENT_START = new Set([
  'SELECT', 'INSERT', 'UPDATE', 'DELETE', 'MERGE', 'WITH', 'CREATE', 'ALTER', 'DROP', 'TRUNCATE', 'EXEC',
  'EXECUTE', 'DECLARE', 'SET', 'IF', 'WHILE', 'BEGIN', 'END', 'PRINT', 'USE', 'GRANT', 'REVOKE', 'GO', 'COMMIT',
  'ROLLBACK', 'RETURN', 'VALUES',
]);
const ROUTINE_KINDS = new Set(['PROC', 'PROCEDURE', 'FUNCTION', 'TRIGGER', 'PACKAGE', 'TYPE']);

/** Name following DELETE [FROM] / UPDATE / DROP x, for the description. */
function objectNameAt(toks: Tok[], i: number): string {
  const parts: string[] = [];
  let j = i;
  while (j < toks.length) {
    const t = toks[j];
    if (t.w === 'IDENT' || /^[A-Z_@#$][A-Z0-9_@#$]*$/.test(t.w)) {
      parts.push(t.raw);
      if (toks[j + 1]?.w === '.') { j += 2; continue; }
    }
    break;
  }
  return parts.join('.');
}

export function findDestructive(batches: SqlBatch[], dialect: Dialect): DestructiveFinding[] {
  const findings: DestructiveFinding[] = [];
  for (const b of batches) {
    const toks = tokenize(b.sql, b.line, dialect);
    for (let i = 0; i < toks.length; i++) {
      const t = toks[i];
      const prev = toks[i - 1]?.w;
      if (t.w === 'CREATE' || (t.w === 'ALTER' && toks[i + 1]?.w !== 'TABLE')) {
        // CREATE [OR REPLACE] PROCEDURE/TRIGGER/... : the body is not executed now; skip to the end of the batch.
        let j = i + 1;
        while (j < toks.length && ['OR', 'REPLACE', 'ALTER', 'EDITIONABLE', 'NONEDITIONABLE', 'DEFINER', 'TEMP', 'TEMPORARY'].includes(toks[j].w)) j++;
        if (j < toks.length && ROUTINE_KINDS.has(toks[j].w)) break;
        continue;
      }
      if (t.w === 'DROP' && prev !== 'ON' && t.depth === 0) {
        if (toks[i - 1] && i >= 2 && findAlterTable(toks, i)) {
          findings.push({ kind: 'ALTER_DROP', description: `ALTER TABLE … DROP ${toks[i + 1]?.raw ?? ''}`.trim(), line: t.line });
        } else {
          const what = toks[i + 1]?.raw ?? '';
          const name = objectNameAt(toks, skipIfExists(toks, i + 2));
          findings.push({ kind: 'DROP', description: `DROP ${what.toUpperCase()} ${name}`.trim(), line: t.line });
        }
        continue;
      }
      if (t.w === 'TRUNCATE' && t.depth === 0) {
        const j = toks[i + 1]?.w === 'TABLE' ? i + 2 : i + 1;
        findings.push({ kind: 'TRUNCATE', description: `TRUNCATE ${objectNameAt(toks, j)}`.trim(), line: t.line });
        continue;
      }
      if ((t.w === 'DELETE' || t.w === 'UPDATE') && prev !== 'ON' && prev !== 'FOR' && prev !== 'THEN' && prev !== 'OF'
        && prev !== 'INSTEAD' && prev !== 'AFTER' && prev !== 'BEFORE' && prev !== ',' && prev !== 'DO') {
        if (t.w === 'UPDATE' && toks[i + 1]?.w === 'STATISTICS') continue;
        const depth = t.depth;
        let hasWhere = false;
        let j = i + 1;
        for (; j < toks.length; j++) {
          const u = toks[j];
          if (u.depth < depth) break;
          if (u.depth > depth) continue;
          if (u.w === ';') break;
          if (u.w === 'WHERE') { hasWhere = true; break; }
          if (u.w === 'CURRENT' && toks[j - 1]?.w === 'WHERE') { hasWhere = true; break; }
          if (STATEMENT_START.has(u.w) && u.w !== 'SET' && j > i + 1) break;
        }
        if (!hasWhere) {
          let k = i + 1;
          if (t.w === 'DELETE' && toks[k]?.w === 'FROM') k++;
          if (toks[k]?.w === 'TOP' || toks[k]?.w === 'ONLY') k += toks[k + 1]?.w === '(' ? 4 : 1;
          const name = objectNameAt(toks, k);
          findings.push({ kind: t.w, description: `${t.w} without WHERE${name ? ` on ${name}` : ''}`, line: t.line });
        }
      }
    }
  }
  return findings;
}

function skipIfExists(toks: Tok[], i: number): number {
  if (toks[i]?.w === 'IF' && toks[i + 1]?.w === 'EXISTS') return i + 2;
  return i;
}

/** True when DROP at index i belongs to an ALTER TABLE statement. */
function findAlterTable(toks: Tok[], i: number): boolean {
  for (let j = i - 1; j >= 0; j--) {
    const w = toks[j].w;
    if (w === ';') return false;
    if (w === 'ALTER') return toks[j + 1]?.w === 'TABLE';
    if (STATEMENT_START.has(w) && w !== 'SET') return false;
  }
  return false;
}
