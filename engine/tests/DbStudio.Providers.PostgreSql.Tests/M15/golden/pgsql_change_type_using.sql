-- rebuildRequired: false, transactional: true

-- [alter] Changing varchar(20) to integer converts existing data (USING status::integer); the change fails if a value cannot be converted.
ALTER TABLE public.orders
    ALTER COLUMN status DROP DEFAULT,
    ALTER COLUMN status TYPE integer USING status::integer;
