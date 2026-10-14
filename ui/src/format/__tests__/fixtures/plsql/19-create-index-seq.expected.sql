CREATE INDEX ix_orders_customer ON orders (customer_id, created_at DESC);
CREATE SEQUENCE orders_seq START WITH 1 INCREMENT BY 1 NOCACHE;
