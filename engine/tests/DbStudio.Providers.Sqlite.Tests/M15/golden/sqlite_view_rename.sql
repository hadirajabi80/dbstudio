-- rebuildRequired: false, transactional: true
-- warning: SQLite has no WITH CHECK OPTION; the option is ignored.

-- [drop]
DROP VIEW IF EXISTS "V1";

-- [drop]
DROP VIEW IF EXISTS "V2";

-- [create]
CREATE VIEW "V2" AS
SELECT 1 AS a;
