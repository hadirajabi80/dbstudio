-- rebuildRequired: false, transactional: true

-- [create]
CREATE TABLE public.orders (
    id integer NOT NULL,
    customer_id integer NOT NULL,
    order_date date NOT NULL,
    status varchar(20) DEFAULT 'new' NOT NULL,
    total numeric(12,2) DEFAULT 0 NOT NULL,
    note text,
    CONSTRAINT pk_orders PRIMARY KEY (id),
    CONSTRAINT uq_orders_customer_date UNIQUE (customer_id, order_date),
    CONSTRAINT ck_orders_total CHECK (total >= 0),
    CONSTRAINT fk_orders_customers FOREIGN KEY (customer_id) REFERENCES public.customers (id)
);

-- [index]
CREATE INDEX ix_orders_customer_id ON public.orders USING btree (customer_id);

-- [comment]
COMMENT ON TABLE public.orders IS 'Customer orders';

-- [comment]
COMMENT ON COLUMN public.orders.note IS 'Free text';
