-- rebuildRequired: false, transactional: false

-- [alter]
ALTER TABLE shop.orders ADD COLUMN channel String DEFAULT 'web' AFTER note;
