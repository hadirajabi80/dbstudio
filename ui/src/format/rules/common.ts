// Dialect-independent formatter tables.
import type { Dialect } from '../../intel/types';

export function set(s: string): Set<string> {
  return new Set(s.split(/\s+/).filter(Boolean));
}

export interface FormatRules {
  dialect: Dialect;
  /** Words that start a statement (T-SQL statement boundary detection without `;`). */
  statementStarts: Set<string>;
  /** After these words a statement cannot end (the next statement-start word continues the statement). */
  incomplete: Set<string>;
  /** Keywords that are called like functions: no space before `(`. */
  functionKeywords: Set<string>;
  /** Keywords that end an operand (a following `-` is binary). */
  operandKeywords: Set<string>;
  /** Clause keywords that start a condition broken at AND/OR. */
  conditionClauses: Set<string>;
}

/** Words before a name whose `(` gets a space: `INSERT INTO t (a)`, `CREATE TABLE t (`, `REFERENCES t (id)`. */
export const NAME_PAREN_KEYWORDS = set(`
  INTO TABLE VIEW REFERENCES PROCEDURE PROC FUNCTION TYPE INDEX ON TRIGGER PACKAGE BODY OBJECT RECORD UPDATE
  MERGE USING EXISTS KEY`);

export const OPERAND_KEYWORDS_COMMON = set(`
  END NULL TRUE FALSE CURRENT_DATE CURRENT_TIME CURRENT_TIMESTAMP CURRENT_USER SESSION_USER SYSTEM_USER USER
  SYSDATE SYSTIMESTAMP ROWNUM LEVEL ROWID`);

export const SET_OPERATORS = set('UNION EXCEPT INTERSECT MINUS');
export const JOIN_WORDS = set('JOIN INNER LEFT RIGHT FULL CROSS NATURAL OUTER STRAIGHT_JOIN');
export const CONDITION_CLAUSES = set('WHERE HAVING ON CONNECT START');
