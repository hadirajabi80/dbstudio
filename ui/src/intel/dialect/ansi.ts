// Batch 3 (plan-batch3): a small ANSI SQL base for the lazily loaded dialect modules (dialect/<id>.ts). Lazy-only: never
// import it from the shell (it would land in the initial bundle). Pure data, type imports only (see DialectKit in spec.ts).
import type { Dialect } from '../types';
import type { SpecInit } from './spec';

/** buildSpec() input of a plain ANSI dialect: the WP0 stubs spread it and override what they know. */
export function ansiInit(id: Dialect): SpecInit {
  return {
    id,
    keywords: `
      ALL ALTER AND ANY AS ASC BETWEEN BY CASE CAST CHECK COLUMN CONSTRAINT CREATE CROSS DEFAULT DELETE DESC DISTINCT DROP
      ELSE END EXISTS FALSE FOR FOREIGN FROM FULL GRANT GROUP HAVING IN INNER INSERT INTO IS JOIN KEY LEFT LIKE LIMIT NOT
      NULL ON OR ORDER OUTER PRIMARY REFERENCES RIGHT SELECT SET TABLE THEN TO TRUE UNION UNIQUE UPDATE USING VALUES VIEW
      WHEN WHERE WITH`,
    contextual: 'OFFSET FETCH FIRST NEXT ROWS ONLY OVER PARTITION',
    statementStarts: 'SELECT INSERT UPDATE DELETE WITH CREATE ALTER DROP TRUNCATE BEGIN COMMIT ROLLBACK USE SHOW EXPLAIN',
    dataTypes: 'INT INTEGER BIGINT SMALLINT DECIMAL NUMERIC FLOAT DOUBLE BOOLEAN CHAR VARCHAR TEXT DATE TIME TIMESTAMP',
    catalog: { functions: [] },
    quote: ['"', '"'],
    caseFolding: 'insensitive',
    batchSeparator: null,
    identExtra: '$',
    snippets: [],
    selectKeywords: 'DISTINCT, CASE, CAST, NULL, EXISTS, NOT',
    afterSourceKeywords: 'WHERE, JOIN, LEFT JOIN, INNER JOIN, GROUP BY, ORDER BY, HAVING, LIMIT, UNION, AS',
    afterExprKeywords: 'AND, OR, NOT, IN, IS NULL, IS NOT NULL, LIKE, BETWEEN, GROUP BY, ORDER BY, LIMIT',
    startKeywords: 'SELECT, INSERT INTO, UPDATE, DELETE FROM, WITH, CREATE TABLE, ALTER TABLE, DROP TABLE',
  };
}
