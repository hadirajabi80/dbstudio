// Procedure / function / package / trigger templates per dialect (docs/PLAN-M1.5.md 1.3.3). Output is Monaco snippet
// syntax (`${1:name}` tab stops, `${0}` final cursor); `snippetToText` resolves it to plain text. Pure TypeScript.
import type { Dialect } from '../../api/types';
import { quoteIdent } from '../../lib/sql';

export type RoutineKind = 'procedure' | 'function' | 'package' | 'trigger';
export type ParamDirection = 'in' | 'out' | 'inout';

export interface WizardParam {
  name: string;
  type: string;
  direction: ParamDirection;
  /** Default value expression; empty = none. */
  default: string;
}

export interface WizardSpec {
  dialect: Dialect;
  kind: RoutineKind;
  schema: string | null;
  name: string;
  params: WizardParam[];
  /** Function return type. */
  returns: string;
  /** Trigger details. */
  trigger?: { table: string; timing: TriggerTiming; events: ('INSERT' | 'UPDATE' | 'DELETE')[]; forEachRow: boolean };
  /** Oracle: add a procedure/function to an existing package (its current spec and body DDL). */
  packageMember?: { packageName: string; spec: string; body: string | null; member: 'procedure' | 'function' } | null;
}

/** Kinds offered per dialect (SQLite has no stored routines, only triggers). */
export function kindsFor(dialect: Dialect): RoutineKind[] {
  if (dialect === 'sqlite') return ['trigger'];
  if (dialect === 'plsql') return ['procedure', 'function', 'package', 'trigger'];
  return ['procedure', 'function', 'trigger'];
}

export type TriggerTiming = 'BEFORE' | 'AFTER' | 'INSTEAD OF';

/**
 * Timings a trigger can have on a table or on a view. Views only take INSTEAD OF triggers in every dialect; SQL Server
 * tables have no BEFORE triggers, and SQLite / Oracle tables no INSTEAD OF.
 */
export function triggerTimings(dialect: Dialect, onView: boolean): TriggerTiming[] {
  if (onView) return ['INSTEAD OF'];
  return dialect === 'tsql' ? ['AFTER', 'INSTEAD OF'] : ['BEFORE', 'AFTER'];
}

export function defaultTiming(dialect: Dialect, onView: boolean): TriggerTiming {
  return onView ? 'INSTEAD OF' : dialect === 'plsql' ? 'BEFORE' : 'AFTER';
}

export const DEFAULT_PARAM_TYPE: Record<Dialect, string> = {
  tsql: 'int', plsql: 'NUMBER', sqlite: 'INTEGER', pgsql: 'integer',
  // WP-MY begin
  mysql: 'int',
  // WP-MY end
  // WP-CH begin
  clickhouse: 'Int32',
  // WP-CH end
  // WP-SF begin
  snowflake: 'NUMBER',
  // WP-SF end
  // WP-CS begin
  cql: 'int',
  // WP-CS end
};
export const DEFAULT_RETURN_TYPE: Record<Dialect, string> = {
  tsql: 'int', plsql: 'NUMBER', sqlite: 'INTEGER', pgsql: 'integer',
  // WP-MY begin
  mysql: 'int',
  // WP-MY end
  // WP-CH begin
  clickhouse: 'Int32',
  // WP-CH end
  // WP-SF begin
  snowflake: 'NUMBER',
  // WP-SF end
  // WP-CS begin
  cql: 'int',
  // WP-CS end
};

/** Escape literal text for a snippet. */
function lit(s: string): string {
  return s.replace(/\\/g, '\\\\').replace(/\$/g, '\\$').replace(/}/g, '\\}');
}

class Stops {
  private n = 0;
  stop(def: string): string {
    return `\${${++this.n}:${lit(def)}}`;
  }
}

function tsqlName(schema: string | null, name: string, s: Stops): string {
  const sc = schema ?? 'dbo';
  return `[${s.stop(sc)}].[${s.stop(name)}]`;
}

function tsqlParamName(n: string): string {
  return n.startsWith('@') ? n : `@${n}`;
}

function oracleName(schema: string | null, name: string, s: Stops): string {
  const n = s.stop(name);
  return schema ? `${lit(quoteIdent(schema, 'plsql'))}.${n}` : n;
}

function oracleParamName(n: string): string {
  return n.replace(/^[@:]/, '');
}

function oracleDirection(d: ParamDirection): string {
  return d === 'inout' ? 'IN OUT' : d.toUpperCase();
}

function tsqlParams(params: WizardParam[], s: Stops, indent = '    '): string[] {
  return params.map((p, i) => {
    const out = p.direction === 'in' ? '' : ' OUTPUT';
    const def = p.default.trim() ? ` = ${lit(p.default.trim())}` : '';
    return `${indent}${lit(tsqlParamName(p.name))} ${s.stop(p.type)}${def}${out}${i < params.length - 1 ? ',' : ''}`;
  });
}

function oracleParams(params: WizardParam[], s: Stops): string {
  return params
    .map((p) => {
      const def = p.default.trim() && p.direction === 'in' ? ` DEFAULT ${lit(p.default.trim())}` : '';
      return `${lit(oracleParamName(p.name))} ${oracleDirection(p.direction)} ${s.stop(p.type)}${def}`;
    })
    .join(',\n    ');
}

function oracleSignature(params: WizardParam[], s: Stops): string {
  return params.length ? ` (\n    ${oracleParams(params, s)}\n)` : '';
}

/** The template as a Monaco snippet. */
export function routineSnippet(spec: WizardSpec): string {
  const s = new Stops();
  const { dialect, kind } = spec;
  const name = spec.name.trim() || defaultName(kind, dialect);
  if (dialect === 'tsql') {
    if (kind === 'procedure') {
      const head = `CREATE OR ALTER PROCEDURE ${tsqlName(spec.schema, name, s)}`;
      const params = tsqlParams(spec.params, s);
      return [head, ...params, 'AS', 'BEGIN', '    SET NOCOUNT ON;', '', '    ${0}', 'END', 'GO', ''].join('\n');
    }
    if (kind === 'function') {
      const head = `CREATE OR ALTER FUNCTION ${tsqlName(spec.schema, name, s)}`;
      const params = tsqlParams(spec.params, s);
      const ret = s.stop(spec.returns || DEFAULT_RETURN_TYPE.tsql);
      return [
        head, '(', ...params, ')', `RETURNS ${ret}`, 'AS', 'BEGIN',
        `    DECLARE @result ${lit(spec.returns || DEFAULT_RETURN_TYPE.tsql)};`, '', '    ${0:SET @result = NULL;}', '', '    RETURN @result;', 'END', 'GO', '',
      ].join('\n');
    }
    if (kind === 'trigger') {
      const t = spec.trigger ?? { table: 'Table', timing: 'AFTER', events: ['INSERT'], forEachRow: false };
      const timing = t.timing === 'BEFORE' ? 'INSTEAD OF' : t.timing;
      return [
        `CREATE OR ALTER TRIGGER ${tsqlName(spec.schema, name, s)}`,
        `ON [${lit(spec.schema ?? 'dbo')}].[${s.stop(t.table)}]`,
        `${timing} ${t.events.join(', ')}`,
        'AS',
        'BEGIN',
        '    SET NOCOUNT ON;',
        '',
        '    ${0:-- inserted / deleted hold the affected rows}',
        'END',
        'GO',
        '',
      ].join('\n');
    }
  }
  if (dialect === 'plsql') {
    if (spec.packageMember) return packageMemberSnippet(spec, s);
    if (kind === 'procedure') {
      return [`CREATE OR REPLACE PROCEDURE ${oracleName(spec.schema, name, s)}${oracleSignature(spec.params, s)} AS`, 'BEGIN', '    ${0:NULL;}', `END ${lit(name)};`, '/', ''].join('\n');
    }
    if (kind === 'function') {
      const ret = spec.returns || DEFAULT_RETURN_TYPE.plsql;
      return [
        `CREATE OR REPLACE FUNCTION ${oracleName(spec.schema, name, s)}${oracleSignature(spec.params, s)}`,
        `RETURN ${s.stop(ret)} AS`,
        `    v_result ${lit(ret)};`,
        'BEGIN',
        '    ${0:v_result := NULL;}',
        '    RETURN v_result;',
        `END ${lit(name)};`,
        '/',
        '',
      ].join('\n');
    }
    if (kind === 'package') {
      const qn = oracleName(spec.schema, name, s);
      const member = 'do_work';
      const sig = spec.params.length ? ` (\n        ${spec.params.map((p) => `${lit(oracleParamName(p.name))} ${oracleDirection(p.direction)} ${lit(p.type)}`).join(',\n        ')}\n    )` : '';
      const qnPlain = spec.schema ? `${lit(quoteIdent(spec.schema, 'plsql'))}.${lit(name)}` : lit(name);
      return [
        `CREATE OR REPLACE PACKAGE ${qn} AS`,
        `    PROCEDURE ${s.stop(member)}${sig};`,
        `END ${lit(name)};`,
        '/',
        '',
        `CREATE OR REPLACE PACKAGE BODY ${qnPlain} AS`,
        `    PROCEDURE ${lit(member)}${sig} IS`,
        '    BEGIN',
        '        ${0:NULL;}',
        `    END ${lit(member)};`,
        `END ${lit(name)};`,
        '/',
        '',
      ].join('\n');
    }
    if (kind === 'trigger') {
      const t = spec.trigger ?? { table: 'TABLE_NAME', timing: 'BEFORE', events: ['INSERT'], forEachRow: true };
      const table = spec.schema ? `${lit(quoteIdent(spec.schema, 'plsql'))}.${s.stop(t.table)}` : s.stop(t.table);
      return [
        `CREATE OR REPLACE TRIGGER ${oracleName(spec.schema, name, s)}`,
        `${t.timing} ${t.events.join(' OR ')} ON ${table}`,
        ...(t.forEachRow ? ['FOR EACH ROW'] : []),
        'BEGIN',
        `    \${0:${t.forEachRow ? '-- :NEW / :OLD hold the row values' : 'NULL;'}}`,
        'END;',
        '/',
        '',
      ].join('\n');
    }
  }
  if (dialect === 'pgsql') return pgSnippet(spec, name, s);
  if (dialect === 'mysql') return mysqlSnippet(spec, name, s);
  // SQLite: triggers only.
  const t = spec.trigger ?? { table: 'table_name', timing: 'AFTER', events: ['INSERT'], forEachRow: true };
  const n = spec.schema && spec.schema !== 'main' ? `${lit(quoteIdent(spec.schema, 'sqlite'))}.${s.stop(name)}` : s.stop(name);
  const event = t.events[0] ?? 'INSERT';
  return [
    `CREATE TRIGGER ${n}`,
    `${t.timing} ${event} ON ${s.stop(t.table)}`,
    'FOR EACH ROW',
    'BEGIN',
    `    \${0:SELECT 1; -- NEW / OLD hold the row values}`,
    'END;',
    '',
  ].join('\n');
}

/**
 * MySQL / MariaDB: BEGIN … END bodies (the console keeps a routine whole, DELIMITER is not needed); parameter modes only
 * on procedures; one event per trigger (there is no INSERT OR UPDATE).
 */
function mysqlSnippet(spec: WizardSpec, name: string, s: Stops): string {
  const q = (n: string) => lit(quoteIdent(n, 'mysql'));
  const full = spec.schema ? `${q(spec.schema)}.${s.stop(name)}` : s.stop(name);
  const params = spec.params
    .map((p) => `${spec.kind === 'procedure' ? `${p.direction.toUpperCase()} ` : ''}${lit(oracleParamName(p.name))} ${s.stop(p.type)}`)
    .join(', ');
  if (spec.kind === 'procedure') return [`CREATE PROCEDURE ${full}(${params})`, 'BEGIN', '    ${0:SELECT 1;}', 'END;', ''].join('\n');
  if (spec.kind === 'function') {
    const ret = spec.returns || DEFAULT_RETURN_TYPE.mysql;
    return [
      `CREATE FUNCTION ${full}(${params})`, `RETURNS ${s.stop(ret)}`, 'DETERMINISTIC', 'BEGIN', `    DECLARE v_result ${lit(ret)};`,
      '    ${0:SET v_result = NULL;}', '    RETURN v_result;', 'END;', '',
    ].join('\n');
  }
  const t = spec.trigger ?? { table: 'table_name', timing: 'BEFORE', events: ['INSERT'], forEachRow: true };
  const table = spec.schema ? `${q(spec.schema)}.${s.stop(t.table)}` : s.stop(t.table);
  return [
    `CREATE TRIGGER ${full}`, `${t.timing} ${t.events[0] ?? 'INSERT'} ON ${table}`, 'FOR EACH ROW', 'BEGIN',
    '    ${0:-- NEW / OLD hold the row values}', 'END;', '',
  ].join('\n');
}

function pgName(schema: string | null, name: string, s: Stops): string {
  const n = s.stop(name);
  return schema ? `${lit(quoteIdent(schema, 'pgsql'))}.${n}` : n;
}

/** `IN` is the default mode and left out; OUT / INOUT come before the name (`INOUT p_total numeric`). */
function pgParams(params: WizardParam[], s: Stops): string {
  return params
    .map((p) => {
      const mode = p.direction === 'in' ? '' : `${p.direction.toUpperCase()} `;
      const def = p.default.trim() && p.direction !== 'out' ? ` DEFAULT ${lit(p.default.trim())}` : '';
      return `${mode}${lit(oracleParamName(p.name))} ${s.stop(p.type)}${def}`;
    })
    .join(', ');
}

/**
 * PostgreSQL templates (docs/PLAN-PG.md 4.2): PL/pgSQL bodies in `$$ … $$`; a trigger is a `RETURNS trigger` function
 * plus `CREATE OR REPLACE TRIGGER … EXECUTE FUNCTION` (PostgreSQL 14+).
 */
function pgSnippet(spec: WizardSpec, name: string, s: Stops): string {
  const dollars = lit('$$');
  if (spec.kind === 'procedure') {
    return [
      `CREATE OR REPLACE PROCEDURE ${pgName(spec.schema, name, s)}(${pgParams(spec.params, s)})`,
      'LANGUAGE plpgsql',
      `AS ${dollars}`,
      'BEGIN',
      '    ${0:NULL;}',
      'END',
      `${dollars};`,
      '',
    ].join('\n');
  }
  if (spec.kind === 'function') {
    const ret = spec.returns || DEFAULT_RETURN_TYPE.pgsql;
    return [
      `CREATE OR REPLACE FUNCTION ${pgName(spec.schema, name, s)}(${pgParams(spec.params, s)})`,
      `RETURNS ${s.stop(ret)}`,
      'LANGUAGE plpgsql',
      `AS ${dollars}`,
      'DECLARE',
      `    v_result ${lit(ret)};`,
      'BEGIN',
      '    ${0:v_result := NULL;}',
      '    RETURN v_result;',
      'END',
      `${dollars};`,
      '',
    ].join('\n');
  }
  // Trigger: a RETURNS trigger function plus the trigger that executes it.
  const t = spec.trigger ?? { table: 'table_name', timing: 'BEFORE', events: ['INSERT'], forEachRow: true };
  const fn = `${name}_fn`;
  const q = (n: string) => lit(quoteIdent(n, 'pgsql'));
  const fnName = spec.schema ? `${q(spec.schema)}.${q(fn)}` : q(fn);
  const table = spec.schema ? `${q(spec.schema)}.${s.stop(t.table)}` : s.stop(t.table);
  // Row triggers return the row to keep (NEW is NULL for DELETE, OLD for INSERT); statement triggers return NULL.
  const events = t.events.length ? t.events : ['INSERT'];
  const ret = !t.forEachRow ? 'RETURN NULL;'
    : events.every((e) => e === 'DELETE') ? 'RETURN OLD;'
      : events.includes('DELETE') ? 'RETURN COALESCE(NEW, OLD);' : 'RETURN NEW;';
  return [
    `CREATE OR REPLACE FUNCTION ${fnName}()`,
    'RETURNS trigger',
    'LANGUAGE plpgsql',
    `AS ${dollars}`,
    'BEGIN',
    `    \${0:${ret}}`,
    'END',
    `${dollars};`,
    '',
    `CREATE OR REPLACE TRIGGER ${q(name)}`,
    `${t.timing} ${events.join(' OR ')} ON ${table}`,
    `FOR EACH ${t.forEachRow ? 'ROW' : 'STATEMENT'}`,
    `EXECUTE FUNCTION ${fnName}();`,
    '',
  ].join('\n');
}

/** Oracle: append a member to an existing package spec and body (both re-created with CREATE OR REPLACE). */
function packageMemberSnippet(spec: WizardSpec, s: Stops): string {
  const pm = spec.packageMember!;
  const isFn = pm.member === 'function';
  const name = spec.name.trim() || (isFn ? 'new_function' : 'new_procedure');
  const params = spec.params.length ? ` (${spec.params.map((p) => `${oracleParamName(p.name)} ${oracleDirection(p.direction)} ${p.type}`).join(', ')})` : '';
  const ret = isFn ? ` RETURN ${spec.returns || DEFAULT_RETURN_TYPE.plsql}` : '';
  const decl = `    ${isFn ? 'FUNCTION' : 'PROCEDURE'} ${name}${params}${ret};`;
  const impl = [
    `    ${isFn ? 'FUNCTION' : 'PROCEDURE'} ${name}${params}${ret} IS`,
    '    BEGIN',
    '        \u0000BODY\u0000',
    `    END ${name};`,
  ];
  const specText = insertBeforeFinalEnd(orReplace(pm.spec), [decl]);
  const bodySource = pm.body ?? `CREATE OR REPLACE PACKAGE BODY ${spec.schema ? `${quoteIdent(spec.schema, 'plsql')}.` : ''}${pm.packageName} AS\nEND ${pm.packageName};`;
  const bodyText = insertBeforeFinalEnd(orReplace(bodySource), impl);
  void s;
  // The marker survives lit() unchanged and becomes the final tab stop inside the new member's body.
  const body = lit(withSlash(bodyText)).replace('\u0000BODY\u0000', isFn ? '${0:RETURN NULL;}' : '${0:NULL;}');
  return `${lit(withSlash(specText))}\n\n${body}\n`;
}

function orReplace(ddl: string): string {
  return ddl.trim().replace(/^CREATE\s+(?!OR\s+REPLACE)(?:EDITIONABLE\s+|NONEDITIONABLE\s+)?/i, 'CREATE OR REPLACE ').replace(/\n\/\s*$/, '');
}

function insertBeforeFinalEnd(ddl: string, lines: string[]): string {
  const m = /\n?\s*END(\s+["\w$#.]+)?\s*;\s*$/i.exec(ddl);
  if (!m) return `${ddl}\n${lines.join('\n')}`;
  return `${ddl.slice(0, m.index)}\n\n${lines.join('\n')}\n${ddl.slice(m.index).replace(/^\n?\s*/, '')}`;
}

function withSlash(ddl: string): string {
  return `${ddl.trimEnd()}\n/`;
}

export function defaultName(kind: RoutineKind, dialect: Dialect): string {
  const base = kind === 'procedure' ? 'NewProcedure' : kind === 'function' ? 'NewFunction' : kind === 'package' ? 'NewPackage' : 'NewTrigger';
  if (dialect === 'plsql') return base.replace(/([a-z])([A-Z])/g, '$1_$2').toUpperCase();
  if (dialect === 'sqlite' || dialect === 'pgsql') return base.replace(/([a-z])([A-Z])/g, '$1_$2').toLowerCase();
  return base;
}

/** Plain text of a snippet: placeholders resolved to their defaults, escapes removed. */
export function snippetToText(snippet: string): string {
  let out = '';
  for (let i = 0; i < snippet.length; i++) {
    const c = snippet[i];
    if (c === '\\' && i + 1 < snippet.length && '\\$}'.includes(snippet[i + 1])) {
      out += snippet[++i];
      continue;
    }
    if (c === '$' && snippet[i + 1] === '{') {
      // ${n} or ${n:default}
      let j = i + 2;
      while (j < snippet.length && /\d/.test(snippet[j])) j++;
      if (snippet[j] === '}') {
        i = j;
        continue;
      }
      if (snippet[j] === ':') {
        let depth = 1;
        let k = j + 1;
        let inner = '';
        while (k < snippet.length && depth > 0) {
          if (snippet[k] === '\\' && k + 1 < snippet.length) {
            inner += snippet[k] + snippet[k + 1];
            k += 2;
            continue;
          }
          if (snippet[k] === '{') depth++;
          if (snippet[k] === '}') depth--;
          if (depth > 0) inner += snippet[k];
          k++;
        }
        out += snippetToText(inner);
        i = k - 1;
        continue;
      }
    }
    out += c;
  }
  return out;
}
