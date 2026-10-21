-- rebuildRequired: false, transactional: true

-- [alter]
ALTER TABLE public.orders
    ADD COLUMN channel text DEFAULT 'web' NOT NULL;
