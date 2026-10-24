-- rebuildRequired: false, transactional: false

-- [alter]
ALTER TABLE shop.orders MODIFY COLUMN status REMOVE DEFAULT;
