-- rebuildRequired: false, transactional: false
-- warning: Snowflake DDL is not transactional: each statement commits; a failure leaves the earlier statements applied.

-- [drop]
ALTER TABLE PUBLIC.ORDERS DROP CLUSTERING KEY;

-- [alter] Snowflake only widens a column (longer VARCHAR, more NUMBER precision); NUMBER(38,0) → NUMBER(38,2) is likely refused: add a new column, copy the data and drop the old one instead.
ALTER TABLE PUBLIC.ORDERS ALTER COLUMN CUSTOMER_ID SET DATA TYPE NUMBER(38,2);

-- [alter]
ALTER TABLE PUBLIC.ORDERS ALTER COLUMN NOTE SET DATA TYPE VARCHAR(200);

-- [alter] Fails if NOTE contains NULLs.
ALTER TABLE PUBLIC.ORDERS ALTER COLUMN NOTE SET NOT NULL;

-- [comment]
ALTER TABLE PUBLIC.ORDERS ALTER COLUMN NOTE UNSET COMMENT;

-- [alter]
ALTER TABLE PUBLIC.ORDERS ALTER COLUMN ORDER_DATE DROP DEFAULT;

-- [comment]
ALTER TABLE PUBLIC.ORDERS UNSET COMMENT;
