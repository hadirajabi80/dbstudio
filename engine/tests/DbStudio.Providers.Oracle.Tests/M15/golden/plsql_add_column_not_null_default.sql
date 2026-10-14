-- rebuildRequired: false, transactional: false
-- warning: Oracle commits every DDL statement: if one fails, the statements before it stay applied.

-- [alter]
ALTER TABLE SHOP.ORDERS ADD (CHANNEL VARCHAR2(20) DEFAULT 'web' NOT NULL);
