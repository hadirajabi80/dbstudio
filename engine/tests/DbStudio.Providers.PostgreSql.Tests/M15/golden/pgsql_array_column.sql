-- rebuildRequired: false, transactional: true

-- [create]
CREATE TABLE public.tagged (
    id integer NOT NULL,
    tags text[] DEFAULT '{}' NOT NULL,
    meta jsonb,
    status public.order_status,
    name text COLLATE "C",
    PRIMARY KEY (id)
);
