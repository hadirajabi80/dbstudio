-- rebuildRequired: false, transactional: false
-- warning: Oracle commits every DDL statement: if one fails, the statements before it stay applied.

-- [alter]
ALTER TABLE SHOP.ORDERS ADD CONSTRAINT FK_ORDERS_CUSTOMERS FOREIGN KEY (CUSTOMER_ID) REFERENCES SHOP.CUSTOMERS (ID) ON DELETE CASCADE;
