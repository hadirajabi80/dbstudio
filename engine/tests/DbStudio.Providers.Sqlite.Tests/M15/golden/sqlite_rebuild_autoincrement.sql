-- rebuildRequired: true, transactional: true
-- warning: SQLite cannot alter this in place (column Phone changed): the table is rebuilt and its data copied.

-- [pragma]
PRAGMA foreign_keys = OFF;

-- [rebuild]
CREATE TABLE "Customers__new" (
    "Id" INTEGER CONSTRAINT "PK_Customers" PRIMARY KEY AUTOINCREMENT NOT NULL,
    "Phone" VARCHAR(40)
);

-- [rebuild]
INSERT INTO "Customers__new" ("Id", "Phone")
SELECT "Id", "Phone"
FROM "Customers";

-- [rebuild] Keeps the AUTOINCREMENT counter, so ids of deleted rows are never reused.
INSERT INTO "sqlite_sequence" (name, seq)
SELECT 'Customers__new', seq FROM "sqlite_sequence"
WHERE name = 'Customers' AND NOT EXISTS (SELECT 1 FROM "sqlite_sequence" WHERE name = 'Customers__new');

-- [rebuild]
UPDATE "sqlite_sequence" SET seq = MAX(seq, COALESCE((SELECT seq FROM "sqlite_sequence" WHERE name = 'Customers'), 0))
WHERE name = 'Customers__new';

-- [rebuild]
DROP TABLE "Customers";

-- [rebuild]
ALTER TABLE "Customers__new" RENAME TO "Customers";

-- [pragma]
PRAGMA foreign_key_check;

-- [pragma]
PRAGMA foreign_keys = ON;
