-- rebuildRequired: false, transactional: false
-- warning: Oracle commits every DDL statement: if one fails, the statements before it stay applied.

-- [rename]
ALTER TABLE SHOP.ORDERS RENAME COLUMN NOTE TO REMARKS;
