-- rebuildRequired: false, transactional: true

-- [alter]
ALTER TABLE public.orders
    ADD CONSTRAINT fk_orders_customers FOREIGN KEY (customer_id) REFERENCES public.customers (id) ON DELETE CASCADE ON UPDATE RESTRICT;
