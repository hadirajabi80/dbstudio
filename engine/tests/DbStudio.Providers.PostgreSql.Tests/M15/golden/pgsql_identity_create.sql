-- rebuildRequired: false, transactional: true

-- [create]
CREATE TABLE public.invoices (
    id bigint GENERATED ALWAYS AS IDENTITY NOT NULL,
    amount numeric(12,2) NOT NULL,
    PRIMARY KEY (id)
);
