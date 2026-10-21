create index concurrently if not exists ix_orders_customer on only orders using btree (customer_id, order_date desc nulls last) include (total) where status <> 'cancelled';
create unique index on customers (lower(email));
