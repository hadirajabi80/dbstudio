// PostgreSQL designer logic (docs/PLAN-PG.md 4.2): table model defaults and validation, array helpers, catalog types
// in the type list, plpgsql templates, the F4 rewrite and the mock scripter's DDL shape.
import { describe, expect, it } from 'vitest';
import type { CatalogSnapshot, TableModel } from '../../api/types';
import { scriptPgTable, scriptPgView } from '../../mocks/m15/pgDesigner';
import { scriptToText, splitForApply } from '../ddl';
import { defaultName, kindsFor, routineSnippet, snippetToText, triggerTimings, type WizardSpec } from '../proc/templates';
import { isScriptEditable, rewriteForEdit } from '../rewrite';
import {
  addColumn, addIndex, catalogTypes, defaultConstraintName, defaultPkClustered, duplicateColumn, isArrayType, newTableModel, referentialActions, updateColumn,
  validateTable, withArray,
} from '../table/model';

const named = (t: TableModel, name: string) => ({ ...t, name });

describe('pgsql table model', () => {
  it('a new table starts with a bigint GENERATED ALWAYS identity key, not clustered', () => {
    const t = newTableModel('pgsql', 'public');
    expect(t.columns[0]).toMatchObject({ name: 'id', type: 'bigint', nullable: false, identity: { seed: 1, increment: 1, always: true } });
    expect(t.primaryKey).toEqual({ name: null, columns: ['id'], clustered: false });
    expect(defaultPkClustered('pgsql')).toBe(false);
  });

  it('new columns are lower case text', () => {
    const t = addColumn(newTableModel('pgsql', 'public'), 'pgsql');
    expect(t.columns[1]).toMatchObject({ name: 'column1', type: 'text' });
    expect(duplicateColumn(t, 1, 'pgsql').columns[2].name).toBe('column1_copy');
  });

  it('constraint names are lower case and at most 63 characters', () => {
    const t = named(newTableModel('pgsql', 'public'), 'Orders');
    expect(defaultConstraintName(t, 'pgsql', 'IX', ['CustomerId'])).toBe('ix_orders_customerid');
    expect(defaultConstraintName(named(t, 'x'.repeat(80)), 'pgsql', 'FK', ['y']).length).toBe(63);
    expect(addIndex(t, 'pgsql').indexes[0].name).toBe('ix_orders_id');
  });

  it('all five referential actions for ON DELETE and ON UPDATE', () => {
    expect(referentialActions('pgsql', 'delete')).toEqual(['NO ACTION', 'CASCADE', 'SET NULL', 'SET DEFAULT', 'RESTRICT']);
    expect(referentialActions('pgsql', 'update')).toHaveLength(5);
  });

  it('identity needs smallint / integer / bigint', () => {
    let t = named(newTableModel('pgsql', 'public'), 'orders');
    t = updateColumn(t, 0, { type: 'numeric(10)' }, 'pgsql');
    expect(validateTable(t, 'pgsql').some((i) => /smallint, integer or bigint/.test(i.message))).toBe(true);
    t = updateColumn(t, 0, { type: 'integer' }, 'pgsql');
    expect(validateTable(t, 'pgsql').filter((i) => i.severity === 'error')).toEqual([]);
  });

  it('generated columns must be STORED', () => {
    let t = addColumn(named(newTableModel('pgsql', 'public'), 'lines'), 'pgsql');
    t = updateColumn(t, 1, { type: 'numeric', computed: { expression: 'qty * price', persisted: false } }, 'pgsql');
    expect(validateTable(t, 'pgsql').some((i) => /must be STORED/.test(i.message))).toBe(true);
    t = updateColumn(t, 1, { computed: { expression: 'qty * price', persisted: true } }, 'pgsql');
    expect(validateTable(t, 'pgsql').some((i) => /STORED/.test(i.message))).toBe(false);
  });

  it('array toggle appends and strips []', () => {
    expect(withArray('text', true)).toBe('text[]');
    expect(withArray('varchar(20)[]', false)).toBe('varchar(20)');
    expect(withArray('integer[][]', true)).toBe('integer[]');
    expect(isArrayType('text[]')).toBe(true);
    expect(isArrayType('text')).toBe(false);
  });

  it('catalog types join the type list: bare on the search_path, qualified elsewhere', () => {
    const snap = {
      connectionId: 'c', dialect: 'pgsql', database: 'shop', defaultSchema: 'public', version: 1, databases: [], searchPath: ['public'],
      schemas: [
        { name: 'public', version: 1, objects: [{ t: 'type', n: 'order_status', c: [['new', 'enum label', 0, 0, 0, null]] }, { t: 'table', n: 'orders' }] },
        { name: 'sales', version: 1, objects: [{ t: 'type', n: 'Money Kind' }] },
      ],
    } as CatalogSnapshot;
    expect(catalogTypes(snap).map((t) => t.name)).toEqual(['order_status', 'sales."Money Kind"']);
    expect(catalogTypes({ ...snap, dialect: 'tsql' })).toEqual([]);
  });
});

describe('pgsql mock scripter (engine script shape)', () => {
  const design = (): TableModel => {
    let t = named(newTableModel('pgsql', 'public'), 'tickets');
    t = addColumn(t, 'pgsql', 1, { name: 'tags', type: 'text[]' });
    t = addColumn(t, 'pgsql', 2, { name: 'status', type: 'order_status', nullable: false, default: "'new'" });
    t = addColumn(t, 'pgsql', 3, { name: 'title', type: 'text', comment: "Customer's words" });
    t = { ...t, comment: 'Support tickets', indexes: [{ name: 'ix_tickets_status', columns: [{ name: 'status', desc: false }], unique: false, clustered: false, include: ['title'], filter: "status <> 'cancelled'" }] };
    return t;
  };

  it('CREATE TABLE with identity, array, enum, INCLUDE / WHERE index and comments', () => {
    const s = scriptPgTable({ database: null, original: null, desired: design() });
    expect(s.transactional).toBe(true);
    expect(s.rebuildRequired).toBe(false);
    expect(s.statements.map((x) => x.sql)).toEqual([
      "CREATE TABLE public.tickets (\n    id bigint GENERATED ALWAYS AS IDENTITY NOT NULL,\n    tags text[],\n    status order_status DEFAULT 'new' NOT NULL,\n    title text,\n    PRIMARY KEY (id)\n)",
      "CREATE INDEX ix_tickets_status ON public.tickets USING btree (status) INCLUDE (title) WHERE status <> 'cancelled'",
      "COMMENT ON TABLE public.tickets IS 'Support tickets'",
      "COMMENT ON COLUMN public.tickets.title IS 'Customer''s words'",
    ]);
    const text = scriptToText(s.statements, 'pgsql').text;
    expect(splitForApply(text, 'pgsql')).toHaveLength(4);
  });

  it('ALTER combines column subcommands into one statement', () => {
    const o = design();
    const d = updateColumn(updateColumn(o, 3, { nullable: false }, 'pgsql'), 0, { identity: { seed: 1, increment: 1, always: false } }, 'pgsql');
    const s = scriptPgTable({ database: null, original: o, desired: { ...d, columns: [...d.columns, { ...d.columns[3], id: null, name: 'note', nullable: true }] } });
    expect(s.statements[0].sql).toBe('ALTER TABLE public.tickets\n    ALTER COLUMN id SET GENERATED BY DEFAULT,\n    ALTER COLUMN title SET NOT NULL,\n    ADD COLUMN note text');
  });

  it('views: CREATE OR REPLACE … WITH CASCADED CHECK OPTION', () => {
    const v = scriptPgView({ database: null, schema: 'public', name: 'open_tickets', originalName: null, body: "SELECT * FROM tickets WHERE status = 'new';", options: { schemaBinding: false, checkOption: true, force: false } });
    expect(v.statements[0].sql).toBe("CREATE OR REPLACE VIEW public.open_tickets AS\nSELECT * FROM tickets WHERE status = 'new'\nWITH CASCADED CHECK OPTION");
  });
});

describe('pgsql routine templates', () => {
  const spec = (p: Partial<WizardSpec>): WizardSpec => ({ dialect: 'pgsql', kind: 'procedure', schema: 'public', name: '', params: [], returns: '', ...p });

  it('kinds, default names and trigger timings', () => {
    expect(kindsFor('pgsql')).toEqual(['procedure', 'function', 'trigger']);
    expect(defaultName('function', 'pgsql')).toBe('new_function');
    expect(triggerTimings('pgsql', false)).toEqual(['BEFORE', 'AFTER']);
    expect(triggerTimings('pgsql', true)).toEqual(['INSTEAD OF']);
  });

  it('procedure: LANGUAGE plpgsql, $$ body, IN mode omitted, INOUT first', () => {
    const text = snippetToText(routineSnippet(spec({ name: 'add_line', params: [{ name: 'p_order', type: 'bigint', direction: 'in', default: '' }, { name: 'p_no', type: 'integer', direction: 'inout', default: '' }] })));
    expect(text).toBe('CREATE OR REPLACE PROCEDURE public.add_line(p_order bigint, INOUT p_no integer)\nLANGUAGE plpgsql\nAS $$\nBEGIN\n    NULL;\nEND\n$$;\n');
  });

  it('function: RETURNS, DECLARE v_result, DEFAULT values', () => {
    const text = snippetToText(routineSnippet(spec({ kind: 'function', name: 'fn_tax', returns: 'numeric', params: [{ name: 'amount', type: 'numeric', direction: 'in', default: '' }, { name: 'rate', type: 'numeric', direction: 'in', default: '0.21' }] })));
    expect(text).toBe('CREATE OR REPLACE FUNCTION public.fn_tax(amount numeric, rate numeric DEFAULT 0.21)\nRETURNS numeric\nLANGUAGE plpgsql\nAS $$\nDECLARE\n    v_result numeric;\nBEGIN\n    v_result := NULL;\n    RETURN v_result;\nEND\n$$;\n');
  });

  it('trigger: trigger function + CREATE OR REPLACE TRIGGER … EXECUTE FUNCTION', () => {
    const text = snippetToText(routineSnippet(spec({ kind: 'trigger', name: 'trg_orders_audit', trigger: { table: 'orders', timing: 'AFTER', events: ['INSERT', 'UPDATE'], forEachRow: true } })));
    expect(text).toBe([
      'CREATE OR REPLACE FUNCTION public.trg_orders_audit_fn()', 'RETURNS trigger', 'LANGUAGE plpgsql', 'AS $$', 'BEGIN', '    RETURN NEW;', 'END', '$$;', '',
      'CREATE OR REPLACE TRIGGER trg_orders_audit', 'AFTER INSERT OR UPDATE ON public.orders', 'FOR EACH ROW', 'EXECUTE FUNCTION public.trg_orders_audit_fn();', '',
    ].join('\n'));
  });

  it('trigger return values follow the events and level', () => {
    const body = (events: ('INSERT' | 'UPDATE' | 'DELETE')[], forEachRow: boolean) =>
      snippetToText(routineSnippet(spec({ kind: 'trigger', name: 't', trigger: { table: 'x', timing: 'BEFORE', events, forEachRow } }))).split('\n')[5].trim();
    expect(body(['DELETE'], true)).toBe('RETURN OLD;');
    expect(body(['INSERT', 'DELETE'], true)).toBe('RETURN COALESCE(NEW, OLD);');
    expect(body(['UPDATE'], false)).toBe('RETURN NULL;');
  });
});

describe('pgsql F4 rewrite', () => {
  it('CREATE FUNCTION / PROCEDURE / VIEW → CREATE OR REPLACE; already replaceable stays', () => {
    const r = rewriteForEdit('CREATE FUNCTION public.f() RETURNS int LANGUAGE sql AS $$ SELECT 1 $$;', { dialect: 'pgsql', type: 'func', name: 'f', schema: 'public' });
    expect(r).toMatchObject({ changed: true, text: 'CREATE OR REPLACE FUNCTION public.f() RETURNS int LANGUAGE sql AS $$ SELECT 1 $$;' });
    expect(rewriteForEdit('CREATE OR REPLACE PROCEDURE p() LANGUAGE sql AS $$ $$', { dialect: 'pgsql', type: 'proc', name: 'p' }).changed).toBe(false);
  });

  it('trigger DDL: both the function and the trigger get OR REPLACE on PostgreSQL 14+', () => {
    const ddl = 'CREATE FUNCTION public.t_fn() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN RETURN NEW; END $$;\nCREATE TRIGGER t BEFORE INSERT ON public.orders FOR EACH ROW EXECUTE FUNCTION public.t_fn();';
    const r = rewriteForEdit(ddl, { dialect: 'pgsql', type: 'trigger', name: 't', schema: 'public', productVersion: '17.2' });
    expect(r.text).toContain('CREATE OR REPLACE FUNCTION public.t_fn()');
    expect(r.text).toContain('CREATE OR REPLACE TRIGGER t BEFORE INSERT');
  });

  it('older servers drop the trigger first', () => {
    const ddl = 'CREATE TRIGGER t BEFORE INSERT ON public.orders FOR EACH ROW EXECUTE FUNCTION public.t_fn();';
    const r = rewriteForEdit(ddl, { dialect: 'pgsql', type: 'trigger', name: 't', schema: 'public', productVersion: '13.15' });
    expect(r.text).toBe(`DROP TRIGGER IF EXISTS t ON public.orders;\n${ddl}`);
    expect(r.note).toMatch(/PostgreSQL 14/);
  });

  it('materialized views are dropped and re-created; types open unchanged with a hint', () => {
    const m = rewriteForEdit('CREATE MATERIALIZED VIEW public.mv AS SELECT 1;', { dialect: 'pgsql', type: 'mview', name: 'mv', schema: 'public' });
    expect(m.text).toBe('DROP MATERIALIZED VIEW IF EXISTS public.mv;\nCREATE MATERIALIZED VIEW public.mv AS SELECT 1;\n');
    const t = rewriteForEdit("CREATE TYPE public.s AS ENUM ('a');", { dialect: 'pgsql', type: 'type', name: 's', schema: 'public' });
    expect(t.changed).toBe(false);
    expect(t.note).toMatch(/ADD VALUE/);
    expect(isScriptEditable('mview', 'pgsql')).toBe(true);
  });
});
