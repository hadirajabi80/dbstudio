-- rebuildRequired: false, transactional: true
-- warning: SQLite does not store table or column comments; they are ignored.

-- [create]
CREATE TABLE "Orders" (
    "Id" INTEGER NOT NULL,
    "CustomerId" INTEGER NOT NULL,
    "OrderDate" DATE NOT NULL,
    "Status" TEXT NOT NULL DEFAULT 'new',
    "Total" NUMERIC(12,2) NOT NULL DEFAULT 0,
    "Note" TEXT,
    CONSTRAINT "PK_Orders" PRIMARY KEY ("Id"),
    CONSTRAINT "UQ_Orders_Customer_Date" UNIQUE ("CustomerId", "OrderDate"),
    CONSTRAINT "CK_Orders_Total" CHECK (Total >= 0),
    CONSTRAINT "FK_Orders_Customers" FOREIGN KEY ("CustomerId") REFERENCES "Customers" ("Id")
);

-- [index]
CREATE INDEX "IX_Orders_CustomerId" ON "Orders" ("CustomerId");
