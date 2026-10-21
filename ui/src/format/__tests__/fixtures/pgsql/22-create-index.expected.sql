CREATE INDEX CONCURRENTLY IF NOT EXISTS ix_orders_customer ON ONLY orders USING btree (
    customer_id,
    order_date DESC NULLS LAST
)
    INCLUDE (total)
    WHERE status <> 'cancelled';

CREATE UNIQUE INDEX ON customers (LOWER(email));
