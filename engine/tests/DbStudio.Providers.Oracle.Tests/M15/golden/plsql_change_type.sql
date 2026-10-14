-- rebuildRequired: false, transactional: false
-- warning: Oracle commits every DDL statement: if one fails, the statements before it stay applied.

-- [alter] Changing VARCHAR2(200) to VARCHAR2(400) fails when existing data does not fit (or the column is not empty for some type changes).
ALTER TABLE SHOP.ORDERS MODIFY (NOTE VARCHAR2(400));
