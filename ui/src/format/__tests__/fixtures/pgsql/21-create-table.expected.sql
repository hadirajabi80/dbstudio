CREATE TABLE IF NOT EXISTS public.orders (
    id BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    customer_id INTEGER NOT NULL REFERENCES customers (id) ON DELETE CASCADE,
    total NUMERIC(12, 2) NOT NULL DEFAULT 0 CHECK (total >= 0),
    status order_status NOT NULL DEFAULT 'new',
    tags TEXT[] DEFAULT '{}',
    meta JSONB,
    line_total NUMERIC GENERATED ALWAYS AS (total * 2) STORED,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    UNIQUE (customer_id, created_at)
) PARTITION BY RANGE (created_at);

CREATE TABLE orders_2024 PARTITION OF orders FOR VALUES FROM ('2024-01-01') TO ('2025-01-01');
CREATE UNLOGGED TABLE scratch (
    id INT
) WITH (fillfactor = 70);
