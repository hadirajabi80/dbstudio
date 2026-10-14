-- rebuildRequired: false, transactional: false
-- warning: Oracle commits every DDL statement: if one fails, the statements before it stay applied.

-- [alter]
ALTER TABLE SHOP.ORDERS MODIFY (STATUS DEFAULT NULL);
