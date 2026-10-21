-- rebuildRequired: false, transactional: true

-- [alter]
ALTER TABLE public.orders
    ALTER COLUMN status DROP DEFAULT;
