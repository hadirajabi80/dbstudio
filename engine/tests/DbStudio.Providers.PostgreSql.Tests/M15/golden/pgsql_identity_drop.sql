-- rebuildRequired: false, transactional: true

-- [alter] The column keeps its values; new rows need explicit values.
ALTER TABLE public.orders
    ALTER COLUMN id DROP IDENTITY IF EXISTS;
