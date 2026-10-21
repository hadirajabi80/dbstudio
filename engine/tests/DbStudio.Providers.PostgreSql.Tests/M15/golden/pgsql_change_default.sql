-- rebuildRequired: false, transactional: true

-- [alter]
ALTER TABLE public.orders
    ALTER COLUMN total SET DEFAULT 1;
