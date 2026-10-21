-- rebuildRequired: false, transactional: true

-- [alter] Adding total_with_tax rewrites the table.
ALTER TABLE public.orders
    ADD COLUMN total_with_tax numeric(12,2) GENERATED ALWAYS AS (total * 1.19) STORED;
