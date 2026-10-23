-- rebuildRequired: false, transactional: false
-- warning: Snowflake does not support CHECK constraints on standard tables; they are not scripted.
-- warning: Snowflake standard tables have no indexes (micro-partitions are pruned automatically); only a clustered index becomes the clustering key.
-- warning: Snowflake records primary, unique and foreign keys but does not enforce them (only NOT NULL is enforced).

-- [create]
CREATE TABLE PUBLIC.ORDERS (
    ID NUMBER(38,0) NOT NULL,
    CUSTOMER_ID NUMBER(38,0) NOT NULL,
    ORDER_DATE DATE NOT NULL,
    STATUS VARCHAR(20) DEFAULT 'new' NOT NULL,
    TOTAL NUMBER(12,2) DEFAULT 0 NOT NULL,
    NOTE VARCHAR(200) COMMENT 'Free text',
    CONSTRAINT PK_ORDERS PRIMARY KEY (ID),
    CONSTRAINT UQ_ORDERS_CUSTOMER_DATE UNIQUE (CUSTOMER_ID, ORDER_DATE),
    CONSTRAINT FK_ORDERS_CUSTOMERS FOREIGN KEY (CUSTOMER_ID) REFERENCES PUBLIC.CUSTOMERS (ID)
)
COMMENT = 'Customer orders';
