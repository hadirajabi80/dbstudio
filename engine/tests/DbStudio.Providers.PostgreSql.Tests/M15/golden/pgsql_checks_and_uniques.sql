-- rebuildRequired: false, transactional: true

-- [alter]
ALTER TABLE public.orders
    DROP CONSTRAINT ck_orders_total,
    ADD CONSTRAINT uq_orders_customer_date UNIQUE (customer_id, order_date),
    ADD CONSTRAINT ck_orders_total CHECK (total >= 0 AND total < 1000000);
