CREATE UNIQUE INDEX IF NOT EXISTS ix_orders_customer ON orders (customer_id, created_at DESC) WHERE status = 'paid';
