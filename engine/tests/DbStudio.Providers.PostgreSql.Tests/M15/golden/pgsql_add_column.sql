-- rebuildRequired: false, transactional: true

-- [alter]
ALTER TABLE public.orders
    ADD COLUMN refunded_at timestamptz;
