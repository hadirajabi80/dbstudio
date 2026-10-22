// SQL "Script as" templates: SELECT / INSERT / UPDATE / DELETE / MERGE (upsert) for tables and views,
// and EXEC / call blocks for routines. Values are dialect parameters (@Name, :NAME, :name) so the script
// runs through Rowlit's parameters dialog.
import type { Dialect } from '../../api/types';
import type { CgColumn, CgInput, CgPackage, CgParam, CgRoutine, CgTable, GeneratedFile } from '../model';
import { callParams, isRefCursor, isRoutine, isTable, returnParam } from '../model';
import type { CodegenOptions } from '../options';
import { bindNameOf, DIALECT_LABEL, objectLabel, routineSqlName } from '../shape';
import { isWritable, qi, tableName } from '../sqlgen';
import { resolveType } from '../types';
import { commentText } from '../writer';

const IND = '    ';

function param(name: string, d: Dialect): string {
  const clean = name.replace(/[^A-Za-z0-9_]/g, '_');
  return d === 'tsql' ? `@${clean}` : `:${clean}`;
}

function list(items: string[], multiline: boolean): string {
  return multiline ? `\n${items.map((i) => IND + i).join(',\n')}\n` : items.join(', ');
}

function selectSql(t: CgTable, d: Dialect): string[] {
  const cols = t.columns.map((c) => qi(c.name, d));
  const multiline = cols.length > 4;
  const head = multiline ? `SELECT\n${cols.map((c) => IND + c).join(',\n')}` : `SELECT ${cols.join(', ')}`;
  const out = [`${head}\nFROM ${tableName(t, d)};`];
  const pk = t.primaryKey;
  if (pk.length) out.push(`${head}\nFROM ${tableName(t, d)}\nWHERE ${pk.map((k) => `${qi(k, d)} = ${param(k, d)}`).join('\n  AND ')};`);
  return out;
}

function insertSql(t: CgTable, d: Dialect): string | null {
  if (t.kind !== 'table') return null;
  const cols = t.columns.filter((c) => isWritable(c, d));
  if (!cols.length) return `INSERT INTO ${tableName(t, d)} DEFAULT VALUES;`;
  const multiline = cols.length > 4;
  // PostgreSQL returns the generated key of an identity / serial column.
  const identity = d === 'pgsql' ? t.columns.find((c) => c.identity) : undefined;
  const returning = identity ? `\nRETURNING ${qi(identity.name, d)}` : '';
  return `INSERT INTO ${tableName(t, d)} (${list(cols.map((c) => qi(c.name, d)), multiline)})\nVALUES (${list(cols.map((c) => param(c.name, d)), multiline)})${returning};`;
}

function updateSql(t: CgTable, d: Dialect): string | null {
  if (t.kind !== 'table' || !t.primaryKey.length) return null;
  const set = t.columns.filter((c) => !t.primaryKey.includes(c.name) && isWritable(c, d));
  if (!set.length) return null;
  return `UPDATE ${tableName(t, d)}\nSET\n${set.map((c) => `${IND}${qi(c.name, d)} = ${param(c.name, d)}`).join(',\n')}\nWHERE ${t.primaryKey.map((k) => `${qi(k, d)} = ${param(k, d)}`).join('\n  AND ')};`;
}

function deleteSql(t: CgTable, d: Dialect): string | null {
  if (t.kind !== 'table' || !t.primaryKey.length) return null;
  return `DELETE FROM ${tableName(t, d)}\nWHERE ${t.primaryKey.map((k) => `${qi(k, d)} = ${param(k, d)}`).join('\n  AND ')};`;
}

function mergeSql(t: CgTable, d: Dialect): string | null {
  if (t.kind !== 'table' || !t.primaryKey.length) return null;
  const pk = t.primaryKey;
  const all = t.columns.filter((c) => pk.includes(c.name) || isWritable(c, d));
  const ins = t.columns.filter((c) => isWritable(c, d));
  const upd = t.columns.filter((c) => !pk.includes(c.name) && isWritable(c, d));
  if (d === 'pgsql') return pgUpsertSql(t, all, upd);
  const on = pk.map((k) => `t.${qi(k, d)} = s.${qi(k, d)}`).join(' AND ');
  if (d === 'sqlite') {
    const cols = ins.map((c) => qi(c.name, d));
    const upsert = upd.length ? `DO UPDATE SET\n${upd.map((c) => `${IND}${qi(c.name, d)} = excluded.${qi(c.name, d)}`).join(',\n')}` : 'DO NOTHING';
    return `INSERT INTO ${tableName(t, d)} (${cols.join(', ')})\nVALUES (${ins.map((c) => param(c.name, d)).join(', ')})\nON CONFLICT (${pk.map((k) => qi(k, d)).join(', ')}) ${upsert};`;
  }
  const source = all.map((c) => `${param(c.name, d)} AS ${qi(c.name, d)}`).join(', ');
  const lines = [
    d === 'tsql' ? `MERGE INTO ${tableName(t, d)} AS t` : `MERGE INTO ${tableName(t, d)} t`,
    d === 'tsql' ? `USING (SELECT ${source}) AS s` : `USING (SELECT ${source} FROM DUAL) s`,
    d === 'tsql' ? `${IND}ON ${on}` : `ON (${on})`,
  ];
  if (upd.length) lines.push('WHEN MATCHED THEN', `${IND}UPDATE SET ${upd.map((c) => `t.${qi(c.name, d)} = s.${qi(c.name, d)}`).join(', ')}`);
  lines.push('WHEN NOT MATCHED THEN', `${IND}INSERT (${ins.map((c) => qi(c.name, d)).join(', ')}) VALUES (${ins.map((c) => `s.${qi(c.name, d)}`).join(', ')})`);
  return `${lines.join('\n')}${d === 'tsql' ? ';' : ';'}`;
}

/**
 * PostgreSQL upsert: INSERT … ON CONFLICT (pk) DO UPDATE SET c = EXCLUDED.c. The key is always inserted (an upsert
 * by key needs it); OVERRIDING SYSTEM VALUE lets an identity key column take the supplied value.
 */
function pgUpsertSql(t: CgTable, cols: CgColumn[], upd: CgColumn[]): string {
  const d: Dialect = 'pgsql';
  const multiline = cols.length > 4;
  const overriding = cols.some((c) => c.identity) ? '\nOVERRIDING SYSTEM VALUE' : '';
  const action = upd.length ? `DO UPDATE SET\n${upd.map((c) => `${IND}${qi(c.name, d)} = EXCLUDED.${qi(c.name, d)}`).join(',\n')}` : 'DO NOTHING';
  return [
    `INSERT INTO ${tableName(t, d)} (${list(cols.map((c) => qi(c.name, d)), multiline)})${overriding}`,
    `VALUES (${list(cols.map((c) => param(c.name, d)), multiline)})`,
    `ON CONFLICT (${t.primaryKey.map((k) => qi(k, d)).join(', ')}) ${action};`,
  ].join('\n');
}

/** Bind names of a PostgreSQL routine's parameters; unnamed parameters become arg1, arg2, ... */
function pgParamNames(r: CgRoutine): Map<CgParam, string> {
  const out = new Map<CgParam, string>();
  let n = 0;
  for (const p of callParams(r)) out.set(p, p.name ? bindNameOf(p) : `arg${++n}`);
  return out;
}

/** `RETURNS TABLE (...)` / `RETURNS SETOF x` (or known result columns): the function is called in FROM. */
function pgReturnsRows(r: CgRoutine): boolean {
  const ret = returnParam(r);
  return !!r.resultColumns?.length || (!!ret && /^(table\s*\(|setof\s)/i.test(ret.dbType.trim()));
}

/**
 * PostgreSQL call: CALL for procedures, SELECT f(...) for scalar functions, SELECT * FROM f(...) for functions that
 * return rows or OUT parameters. Arguments are positional up to the first optional one, then named, so a defaulted
 * argument can be deleted from the call. Procedure OUT parameters take NULL; OUT / INOUT values come back as a row.
 */
function pgExecSql(r: CgRoutine): string {
  const d: Dialect = 'pgsql';
  const name = routineSqlName(r, d, qi);
  const names = pgParamNames(r);
  const params = callParams(r);
  // Unnamed parameters cannot be passed by name: such a routine is called positionally.
  const positionalOnly = params.some((p) => !p.name);
  let named = false;
  const args: { text: string; note: string | null }[] = [];
  for (const p of params) {
    if (p.direction === 'out' && r.kind === 'func') continue;
    const bind = names.get(p)!;
    if (p.hasDefault && !positionalOnly) named = true;
    const value = p.direction === 'out' ? 'NULL' : param(bind, d);
    const note = p.direction === 'out' ? 'out: returned as a row' : p.direction === 'inout' ? 'inout: returned as a row' : p.hasDefault ? 'optional' : null;
    args.push({ text: named ? `${qi(bind, d)} => ${value}` : value, note });
  }
  const multiline = args.length > 3 || args.some((a) => a.note);
  const argText = multiline
    ? `\n${args.map((a, i) => `${IND}${a.text}${i < args.length - 1 ? ',' : ''}${a.note ? ` -- ${a.note}` : ''}`).join('\n')}\n`
    : args.map((a) => a.text).join(', ');
  if (r.kind === 'proc') return `CALL ${name}(${argText});`;
  const ret = returnParam(r);
  const hasOuts = params.some((p) => p.direction === 'out' || p.direction === 'inout');
  if (pgReturnsRows(r) || hasOuts) return `SELECT *\nFROM ${name}(${argText});`;
  if (!ret || /^void$/i.test(ret.dbType.trim())) return `SELECT ${name}(${argText});`;
  return `SELECT ${name}(${argText}) AS result;`;
}

/** Label of a PostgreSQL routine; overloads add their argument types (`public.fn_tax(numeric, numeric)`). */
function pgRoutineLabel(r: CgRoutine, overloaded: boolean): string {
  if (!overloaded) return objectLabel(r);
  const types = callParams(r).filter((p) => p.direction !== 'out').map((p) => resolveType('pgsql', p.dbType).base || p.dbType);
  return `${objectLabel(r)}(${types.join(', ')})`;
}

function execSql(r: CgRoutine, d: Dialect): string {
  if (d === 'pgsql') return pgExecSql(r);
  const name = routineSqlName(r, d, qi);
  const params = callParams(r);
  const ret = returnParam(r);
  if (d === 'tsql') {
    if (r.kind === 'func' && ret) {
      return `SELECT ${name}(${params.map((p) => p.name).join(', ')}) AS Result;`;
    }
    const outs = params.filter((p) => p.direction !== 'in');
    const decl = [`@return_value int`, ...outs.map((p) => `${p.name} ${p.dbType}`)];
    const args = params.map((p) => (p.direction === 'in' ? `${IND}${p.name} = ${p.name}${p.hasDefault ? ' -- optional' : ''}` : `${IND}${p.name} = ${p.name} OUTPUT`));
    return [
      `DECLARE ${decl.join(', ')};`,
      `EXEC @return_value = ${name}${args.length ? '\n' + args.join(',\n') : ''};`,
      `SELECT @return_value AS ReturnValue${outs.map((p) => `, ${p.name} AS ${bindNameOf(p)}`).join('')};`,
    ].join('\n');
  }
  if (r.kind === 'func' && ret) {
    return `SELECT ${name}(${params.map((p) => `${bindNameOf(p)} => ${param(bindNameOf(p), d)}`).join(', ')}) AS result\nFROM DUAL;`;
  }
  // Named notation; OUT parameters (incl. SYS_REFCURSOR) are bind variables the parameters dialog can return.
  const args = params.map((p) => `${IND}${bindNameOf(p)} => ${param(bindNameOf(p), d)}${isRefCursor(p.dbType) ? ' -- refcursor' : p.direction !== 'in' ? ` -- ${p.direction}` : ''}`);
  return `BEGIN\n${IND}${name}(\n${args.map((a, i) => (i < args.length - 1 ? a.replace(/( --.*)?$/, ',$1') : a)).join('\n')}\n${IND});\nEND;\n/`;
}

const header = (label: string, what: string) => `-- ${label}: ${what}`;

const routineKey = (r: CgRoutine) => [r.schema, r.package, r.name].join('.').toLowerCase();

/** Routines that share their qualified name with another routine of the input (PostgreSQL overloads). */
function overloadedKeys(input: CgInput): Set<string> {
  const seen = new Set<string>();
  const out = new Set<string>();
  for (const obj of input.objects) {
    if (!isRoutine(obj)) continue;
    const k = routineKey(obj);
    if (seen.has(k)) out.add(k);
    seen.add(k);
  }
  return out;
}

export function generateSql(input: CgInput, o: CodegenOptions): GeneratedFile[] {
  const d = input.dialect;
  const want = (k: string) => o.flavor === 'all' || o.flavor === k;
  const blocks: string[] = [];
  const overloaded = overloadedKeys(input);
  for (const obj of input.objects) {
    if (isTable(obj)) {
      const label = objectLabel(obj);
      const cm = commentText(obj.comment);
      const parts: string[] = [];
      if (want('select')) parts.push(...selectSql(obj, d).map((s, i) => `${header(label, i ? 'SELECT by key' : 'SELECT')}\n${s}`));
      const ins = want('insert') ? insertSql(obj, d) : null;
      if (ins) parts.push(`${header(label, 'INSERT')}\n${ins}`);
      const upd = want('update') ? updateSql(obj, d) : null;
      if (upd) parts.push(`${header(label, 'UPDATE')}\n${upd}`);
      const del = want('delete') ? deleteSql(obj, d) : null;
      if (del) parts.push(`${header(label, 'DELETE')}\n${del}`);
      const mrg = want('merge') ? mergeSql(obj, d) : null;
      if (mrg) parts.push(`${header(label, d === 'sqlite' || d === 'pgsql' ? 'UPSERT' : 'MERGE')}\n${mrg}`);
      if (parts.length) blocks.push((cm ? `-- ${cm}\n` : '') + parts.join('\n\n'));
    } else if (want('exec') && (isRoutine(obj) || obj.kind === 'package')) {
      const rs: CgRoutine[] = isRoutine(obj) ? [obj] : (obj as CgPackage).members;
      for (const r of rs) {
        const rl = d === 'pgsql' ? pgRoutineLabel(r, overloaded.has(routineKey(r))) : objectLabel(r);
        blocks.push(`${header(rl, r.kind === 'func' ? 'call' : d === 'pgsql' ? 'CALL' : 'EXEC')}\n${execSql(r, d)}`);
      }
    } else if (obj.kind === 'query' && want('select')) {
      blocks.push(`${header(obj.name, 'query')}\n${obj.sql.trim().replace(/;?$/, ';')}`);
    }
  }
  if (!blocks.length) return [];
  const style = d === 'tsql' ? '@Name' : d === 'pgsql' ? ':name' : ':NAME';
  const content = `-- Generated by Rowlit from ${DIALECT_LABEL[d]}. Parameters (${style}) are prompted for when you run a statement.\n\n${blocks.join('\n\n')}\n`;
  return [{ path: `${o.flavor === 'all' ? 'script' : o.flavor}.sql`, language: 'sql', content }];
}

export type { CgParam };
