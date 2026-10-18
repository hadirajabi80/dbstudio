-- rebuildRequired: false, transactional: false
-- warning: Oracle commits every DDL statement: if one fails, the statements before it stay applied.

-- [alter] Narrowing VARCHAR2(20) to VARCHAR2(10) fails when existing values do not fit (ORA-01441).
ALTER TABLE SHOP.ORDERS MODIFY (STATUS VARCHAR2(10));
