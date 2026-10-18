-- rebuildRequired: false, transactional: true
-- warning: SQLite has no WITH CHECK OPTION; the option is ignored.

-- [create]
CREATE VIEW "V2" AS
SELECT 1 AS a;

-- [drop]
DROP VIEW IF EXISTS "V1";
