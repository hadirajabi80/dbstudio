-- rebuildRequired: false, transactional: true

-- [alter]
ALTER TABLE public.orders
    ALTER COLUMN id SET GENERATED ALWAYS,
    ALTER COLUMN id SET INCREMENT BY 5;
