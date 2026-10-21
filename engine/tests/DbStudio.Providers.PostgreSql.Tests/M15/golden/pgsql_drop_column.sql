-- rebuildRequired: false, transactional: true

-- [alter] Dropping column note deletes its data.
ALTER TABLE public.orders
    DROP COLUMN note;
