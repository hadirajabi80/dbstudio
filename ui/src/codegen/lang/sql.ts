// SQL "Script as" templates: SELECT / INSERT / UPDATE / DELETE / MERGE (upsert) for tables and views,
// and EXEC / call blocks for routines. Values are dialect parameters (@Name, :NAME, :name) so the script
// runs through DbStudio's parameters dialog.
import type { Dialect } from '../../api/types';
import type { CgInput, CgPackage, CgParam, CgRoutine, CgTable, GeneratedFile } from '../model';
import { callParams, isRefCursor, isRoutine, isTable, returnParam } from '../model';
import type { CodegenOptions } from '../options';
import { bindNameOf, DIALECT_LABEL, objectLabel, routineSqlName } from '../shape';
import { isWritable, qi, tableName } from '../sqlgen';
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
  return `INSERT INTO ${tableName(t, d)} (${list(cols.map((c) => qi(c.name, d)), multiline)})\nVALUES (${list(cols.map((c) => param(c.name, d)), multiline)});`;
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

function execSql(r: CgRoutine, d: Dialect): string {
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

export function generateSql(input: CgInput, o: CodegenOptions): GeneratedFile[] {
  const d = input.dialect;
  const want = (k: string) => o.flavor === 'all' || o.flavor === k;
  const blocks: string[] = [];
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
      if (mrg) parts.push(`${header(label, d === 'sqlite' ? 'UPSERT' : 'MERGE')}\n${mrg}`);
      if (parts.length) blocks.push((cm ? `-- ${cm}\n` : '') + parts.join('\n\n'));
    } else if (want('exec') && (isRoutine(obj) || obj.kind === 'package')) {
      const rs: CgRoutine[] = isRoutine(obj) ? [obj] : (obj as CgPackage).members;
      for (const r of rs) blocks.push(`${header(objectLabel(r), r.kind === 'func' ? 'call' : 'EXEC')}\n${execSql(r, d)}`);
    } else if (obj.kind === 'query' && want('select')) {
      blocks.push(`${header(obj.name, 'query')}\n${obj.sql.trim().replace(/;?$/, ';')}`);
    }
  }
  if (!blocks.length) return [];
  const content = `-- Generated by DbStudio from ${DIALECT_LABEL[d]}. Parameters (${d === 'tsql' ? '@Name' : ':NAME'}) are prompted for when you run a statement.\n\n${blocks.join('\n\n')}\n`;
  return [{ path: `${o.flavor === 'all' ? 'script' : o.flavor}.sql`, language: 'sql', content }];
}

export type { CgParam };
