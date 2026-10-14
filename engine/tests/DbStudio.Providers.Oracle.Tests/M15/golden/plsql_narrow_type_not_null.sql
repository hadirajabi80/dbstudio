-- rebuildRequired: false, transactional: false
-- warning: Oracle commits every DDL statement: if one fails, the statements before it stay applied.

-- [alter] Changing VARCHAR2(20) to VARCHAR2(10) fails when existing data does not fit (or the column is not empty for some type changes).
ALTER TABLE SHOP.ORDERS MODIFY (STATUS VARCHAR2(10));
