-- rebuildRequired: false, transactional: true

-- [drop]
DROP INDEX "IX_Orders_CustomerId";

-- [index]
CREATE INDEX "IX_Orders_Date_Status" ON "Orders" ("OrderDate" DESC, "Status");
