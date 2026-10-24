-- rebuildRequired: false, transactional: false
-- warning: ClickHouse has no foreign keys; they are not scripted.
-- warning: ClickHouse has no UNIQUE constraints (ReplacingMergeTree deduplicates by the sorting key); they are not scripted.

-- [create]
CREATE TABLE shop.orders
(
    id Int32,
    customer_id Int32,
    order_date Date,
    status String DEFAULT 'new',
    total Decimal(12, 2) DEFAULT 0,
    note Nullable(String) COMMENT 'Free text',
    INDEX ix_orders_customer_id customer_id TYPE minmax GRANULARITY 1,
    CONSTRAINT ck_orders_total CHECK total >= 0
)
ENGINE = MergeTree
ORDER BY id
COMMENT 'Customer orders';
