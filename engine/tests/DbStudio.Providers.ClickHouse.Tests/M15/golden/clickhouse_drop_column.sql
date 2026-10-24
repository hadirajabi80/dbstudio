-- rebuildRequired: false, transactional: false

-- [drop] Dropping a column deletes its data.
ALTER TABLE shop.orders DROP COLUMN note;
