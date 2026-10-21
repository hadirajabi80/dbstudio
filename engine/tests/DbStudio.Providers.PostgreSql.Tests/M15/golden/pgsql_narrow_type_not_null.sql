-- rebuildRequired: false, transactional: true

-- [alter] Narrowing varchar(20) to varchar(10) fails if a value does not fit. Fails if note contains NULLs.
ALTER TABLE public.orders
    ALTER COLUMN status DROP DEFAULT,
    ALTER COLUMN status TYPE varchar(10),
    ALTER COLUMN note SET NOT NULL,
    ALTER COLUMN status SET DEFAULT 'new';
