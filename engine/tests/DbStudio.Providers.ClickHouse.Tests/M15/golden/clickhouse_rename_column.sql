-- rebuildRequired: false, transactional: false

-- [rename]
ALTER TABLE shop.orders RENAME COLUMN note TO remarks;
