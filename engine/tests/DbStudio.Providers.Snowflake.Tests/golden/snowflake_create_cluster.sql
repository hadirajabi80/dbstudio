-- rebuildRequired: false, transactional: false
-- warning: Snowflake records primary, unique and foreign keys but does not enforce them (only NOT NULL is enforced).

-- [create]
CREATE TABLE PUBLIC.ORDERS (
    ID NUMBER(38,0) IDENTITY(1, 1) NOT NULL,
    CUSTOMER_ID NUMBER(38,0) NOT NULL,
    NOTE VARCHAR(100) COMMENT 'free text',
    ORDER_DATE TIMESTAMP_NTZ(9) DEFAULT CURRENT_TIMESTAMP() NOT NULL,
    CONSTRAINT PK_ORDERS PRIMARY KEY (ID),
    CONSTRAINT FK_ORDERS_CUSTOMERS FOREIGN KEY (CUSTOMER_ID) REFERENCES PUBLIC.CUSTOMERS (ID)
)
CLUSTER BY (ORDER_DATE)
COMMENT = 'Shop orders';
