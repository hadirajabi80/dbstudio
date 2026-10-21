-- rebuildRequired: false, transactional: true

-- [create]
CREATE TABLE "Sales"."Orders" (
    "Id" integer NOT NULL,
    "order" text,
    PRIMARY KEY ("Id")
);
