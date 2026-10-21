-- rebuildRequired: false, transactional: true

-- [rename]
ALTER TABLE public.orders RENAME COLUMN note TO remarks;
