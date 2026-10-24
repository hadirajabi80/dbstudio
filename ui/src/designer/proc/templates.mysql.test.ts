// MySQL / MariaDB routine templates (R3-T1): BEGIN … END bodies, parameter modes on procedures only, one trigger event.
import { describe, expect, it } from 'vitest';
import { routineSnippet, snippetToText, type WizardSpec } from './templates';

const base: WizardSpec = { dialect: 'mysql', kind: 'procedure', schema: 'shop', name: 'p_demo', params: [], returns: '' };
const p = (name: string, direction: 'in' | 'out' | 'inout' = 'in') => ({ name, type: 'int', direction, default: '' });
const text = (s: WizardSpec) => snippetToText(routineSnippet(s));

describe('mysql routine templates', () => {
  it('procedure: modes before the parameter name, BEGIN … END', () => {
    const t = text({ ...base, params: [p('p_id'), p('@total', 'out')] });
    expect(t).toBe('CREATE PROCEDURE shop.p_demo(IN p_id int, OUT total int)\nBEGIN\n    SELECT 1;\nEND;\n');
  });

  it('function: no parameter modes, DETERMINISTIC, result variable', () => {
    const t = text({ ...base, kind: 'function', name: 'f_demo', params: [p('p_id')], returns: 'varchar(20)' });
    expect(t).toBe(
      'CREATE FUNCTION shop.f_demo(p_id int)\nRETURNS varchar(20)\nDETERMINISTIC\nBEGIN\n    DECLARE v_result varchar(20);\n    SET v_result = NULL;\n    RETURN v_result;\nEND;\n',
    );
  });

  it('function without a return type falls back to the dialect default', () => {
    expect(text({ ...base, kind: 'function', name: 'f' })).toContain('RETURNS int');
  });

  it('trigger: a single event, quoted reserved table name', () => {
    const t = text({ ...base, kind: 'trigger', name: 'trg_x', trigger: { table: 'order', timing: 'BEFORE', events: ['UPDATE', 'DELETE'], forEachRow: true } });
    expect(t).toBe('CREATE TRIGGER shop.trg_x\nBEFORE UPDATE ON shop.order\nFOR EACH ROW\nBEGIN\n    -- NEW / OLD hold the row values\nEND;\n');
  });

  it('without a schema the names are bare; the snippet keeps tab stops', () => {
    const snippet = routineSnippet({ ...base, schema: null });
    expect(snippet).toContain('CREATE PROCEDURE ${1:p_demo}()');
    expect(snippet).toContain('${0:SELECT 1;}');
  });
});
