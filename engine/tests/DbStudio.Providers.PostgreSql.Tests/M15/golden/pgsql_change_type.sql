-- rebuildRequired: false, transactional: true

-- [alter] Changing text to varchar(400) converts existing data (USING note::varchar(400)); the change fails if a value cannot be converted.
ALTER TABLE public.orders
    ALTER COLUMN note TYPE varchar(400) USING note::varchar(400);
