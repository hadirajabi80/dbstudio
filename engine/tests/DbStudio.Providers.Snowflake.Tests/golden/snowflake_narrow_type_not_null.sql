-- rebuildRequired: false, transactional: false

-- [alter] Snowflake only widens a column (longer VARCHAR, more NUMBER precision); VARCHAR(20) → VARCHAR(10) is likely refused: add a new column, copy the data and drop the old one instead.
ALTER TABLE PUBLIC.ORDERS ALTER COLUMN STATUS SET DATA TYPE VARCHAR(10);
