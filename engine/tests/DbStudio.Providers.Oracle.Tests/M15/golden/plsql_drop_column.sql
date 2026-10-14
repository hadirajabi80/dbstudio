-- rebuildRequired: false, transactional: false
-- warning: Oracle commits every DDL statement: if one fails, the statements before it stay applied.

-- [drop] Dropping column NOTE deletes its data.
ALTER TABLE SHOP.ORDERS DROP COLUMN NOTE;
