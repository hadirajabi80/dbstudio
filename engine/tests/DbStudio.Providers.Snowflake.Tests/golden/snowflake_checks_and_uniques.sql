-- rebuildRequired: false, transactional: false
-- warning: Snowflake does not support CHECK constraints on standard tables; they are not scripted.
-- warning: Snowflake records primary, unique and foreign keys but does not enforce them (only NOT NULL is enforced).

-- [alter]
ALTER TABLE PUBLIC.ORDERS ADD CONSTRAINT UQ_ORDERS_CUSTOMER_DATE UNIQUE (CUSTOMER_ID, ORDER_DATE);
