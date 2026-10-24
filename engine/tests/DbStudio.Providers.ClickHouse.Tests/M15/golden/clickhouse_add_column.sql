-- rebuildRequired: false, transactional: false

-- [alter]
ALTER TABLE shop.orders ADD COLUMN refunded_at Nullable(Date) AFTER note;
