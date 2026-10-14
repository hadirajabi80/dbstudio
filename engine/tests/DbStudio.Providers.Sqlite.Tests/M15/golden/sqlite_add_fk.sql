-- rebuildRequired: true, transactional: true
-- warning: SQLite cannot alter this in place (foreign keys changed): the table is rebuilt and its data copied.

-- [pragma]
PRAGMA foreign_keys = OFF;

-- [drop]
DROP VIEW IF EXISTS "OrderSummary";

-- [rebuild]
CREATE TABLE "Orders__new" (
    "Id" INTEGER NOT NULL,
    "CustomerId" INTEGER NOT NULL,
    "OrderDate" DATE NOT NULL,
    "Status" TEXT NOT NULL DEFAULT 'new',
    "Total" NUMERIC(12,2) NOT NULL DEFAULT 0,
    "Note" TEXT,
    CONSTRAINT "PK_Orders" PRIMARY KEY ("Id"),
    CONSTRAINT "CK_Orders_Total" CHECK (Total >= 0),
    CONSTRAINT "FK_Orders_Customers" FOREIGN KEY ("CustomerId") REFERENCES "Customers" ("Id") ON DELETE CASCADE
);

-- [rebuild]
INSERT INTO "Orders__new" ("Id", "CustomerId", "OrderDate", "Status", "Total", "Note")
SELECT "Id", "CustomerId", "OrderDate", "Status", "Total", "Note"
FROM "Orders";

-- [rebuild]
DROP TABLE "Orders";

-- [rebuild]
ALTER TABLE "Orders__new" RENAME TO "Orders";

-- [index]
CREATE INDEX "IX_Orders_CustomerId" ON "Orders" ("CustomerId");

-- [create]
CREATE TRIGGER TR_Orders_Audit AFTER UPDATE ON Orders BEGIN UPDATE Orders SET Note = Note WHERE Id = NEW.Id; END;

-- [create]
CREATE VIEW OrderSummary AS SELECT CustomerId, sum(Total) AS Total, max(Note) AS LastNote FROM Orders GROUP BY CustomerId;

-- [pragma]
PRAGMA foreign_key_check;

-- [pragma]
PRAGMA foreign_keys = ON;
