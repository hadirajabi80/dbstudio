-- rebuildRequired: false, transactional: false
-- warning: Snowflake records primary, unique and foreign keys but does not enforce them (only NOT NULL is enforced).

-- [alter]
ALTER TABLE PUBLIC.ORDERS ADD CONSTRAINT FK_ORDERS_CUSTOMERS FOREIGN KEY (CUSTOMER_ID) REFERENCES PUBLIC.CUSTOMERS (ID) ON DELETE CASCADE;
