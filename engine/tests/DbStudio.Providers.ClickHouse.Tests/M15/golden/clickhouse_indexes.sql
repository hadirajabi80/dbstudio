-- rebuildRequired: false, transactional: false

-- [index]
ALTER TABLE shop.orders DROP INDEX ix_orders_customer_id;

-- [index]
ALTER TABLE shop.orders ADD INDEX ix_orders_date_status (order_date, status) TYPE minmax GRANULARITY 1;

-- [index] Builds the index for existing parts in the background (a mutation).
ALTER TABLE shop.orders MATERIALIZE INDEX ix_orders_date_status;
