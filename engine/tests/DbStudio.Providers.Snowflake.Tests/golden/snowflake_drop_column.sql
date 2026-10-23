-- rebuildRequired: false, transactional: false

-- [drop] Dropping NOTE deletes the data (Time Travel keeps the table's history, not a dropped column).
ALTER TABLE PUBLIC.ORDERS DROP COLUMN NOTE;
