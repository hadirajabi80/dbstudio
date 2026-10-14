-- rebuildRequired: false, transactional: false
-- warning: Oracle commits every DDL statement: if one fails, the statements before it stay applied.

-- [comment]
COMMENT ON TABLE SHOP.ORDERS IS 'All orders';

-- [comment]
COMMENT ON COLUMN SHOP.ORDERS.TOTAL IS 'Gross total';
