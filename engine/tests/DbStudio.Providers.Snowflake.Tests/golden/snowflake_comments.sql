-- rebuildRequired: false, transactional: false
-- warning: Snowflake DDL is not transactional: each statement commits; a failure leaves the earlier statements applied.

-- [comment]
ALTER TABLE PUBLIC.ORDERS ALTER COLUMN TOTAL COMMENT 'Gross total';

-- [comment]
ALTER TABLE PUBLIC.ORDERS SET COMMENT = 'All orders';
