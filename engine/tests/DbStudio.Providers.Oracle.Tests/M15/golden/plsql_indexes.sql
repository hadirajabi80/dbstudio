-- rebuildRequired: false, transactional: false
-- warning: Oracle commits every DDL statement: if one fails, the statements before it stay applied.

-- [drop]
DROP INDEX SHOP.IX_ORDERS_CUSTOMER_ID;

-- [index]
CREATE INDEX SHOP.IX_ORDERS_DATE_STATUS ON SHOP.ORDERS (ORDER_DATE DESC, STATUS);
