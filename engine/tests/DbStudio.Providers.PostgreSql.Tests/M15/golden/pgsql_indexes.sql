-- rebuildRequired: false, transactional: true

-- [drop]
DROP INDEX public.ix_orders_customer_id;

-- [index]
CREATE INDEX ix_orders_date_status ON public.orders USING btree (order_date DESC, status) INCLUDE (total);

-- [index]
CREATE UNIQUE INDEX ix_orders_open ON public.orders USING btree (customer_id) WHERE status <> 'cancelled';
