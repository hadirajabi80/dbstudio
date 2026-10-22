import { describe, expect, it } from 'vitest';
import { findReveal, requestObjectSection, useObjectSectionRequests } from './sectionRequests';

describe('DDL reveal (Find in database code match)', () => {
  const ddl = 'CREATE OR REPLACE FUNCTION f()\nRETURNS int AS $$\nSELECT count(*) FROM Customers;\n-- customers again\nSELECT 1 FROM customers;\n$$';

  it('picks the occurrence nearest to the line of the match', () => {
    expect(findReveal(ddl, { text: 'customers', line: 4, matchCase: false })).toEqual({ line: 4, col: 4, endCol: 13 });
    expect(findReveal(ddl, { text: 'customers', line: 1, matchCase: false })).toEqual({ line: 3, col: 22, endCol: 31 });
    expect(findReveal(ddl, { text: 'Customers', line: 5, matchCase: true })).toEqual({ line: 3, col: 22, endCol: 31 });
    expect(findReveal(ddl, { text: 'customers', line: null, matchCase: false })?.line).toBe(3);
    expect(findReveal(ddl, { text: 'orders', line: 1, matchCase: false })).toBeNull();
  });

  it('a section request can carry a reveal', () => {
    requestObjectSection('o_1', 'ddl', { text: 'x', line: 2, matchCase: false });
    expect(useObjectSectionRequests.getState().requests.o_1).toMatchObject({ section: 'ddl', reveal: { text: 'x', line: 2 } });
    requestObjectSection('o_1', 'deps');
    expect(useObjectSectionRequests.getState().requests.o_1.reveal).toBeUndefined();
  });
});
