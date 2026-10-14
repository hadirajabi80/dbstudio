-- rebuildRequired: false, transactional: false
-- warning: Oracle commits every DDL statement: if one fails, the statements before it stay applied.

-- [drop]
ALTER TABLE SHOP.ORDERS DROP CONSTRAINT CK_ORDERS_TOTAL;

-- [alter]
ALTER TABLE SHOP.ORDERS ADD CONSTRAINT UQ_ORDERS_CUSTOMER_DATE UNIQUE (CUSTOMER_ID, ORDER_DATE);

-- [alter]
ALTER TABLE SHOP.ORDERS ADD CONSTRAINT CK_ORDERS_TOTAL CHECK (TOTAL >= 0 AND TOTAL < 1000000);
