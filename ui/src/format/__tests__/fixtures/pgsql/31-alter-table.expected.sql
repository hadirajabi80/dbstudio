ALTER TABLE orders
    ADD COLUMN note TEXT,
    ALTER COLUMN total SET DEFAULT 0,
    DROP COLUMN IF EXISTS legacy,
    ADD CONSTRAINT orders_total_check CHECK (total >= 0);

ALTER TABLE orders RENAME COLUMN note TO remark;
ALTER TABLE ONLY orders ALTER COLUMN status TYPE TEXT USING status::TEXT;
