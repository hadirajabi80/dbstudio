create unique index if not exists ix_orders_customer on orders (customer_id, created_at desc) where status = 'paid';
