-- rebuildRequired: false, transactional: false

-- [alter] Snowflake only lets an existing column's default become a sequence (seq.NEXTVAL); other defaults need a new column.
ALTER TABLE PUBLIC.ORDERS ALTER COLUMN TOTAL SET DEFAULT 1;
