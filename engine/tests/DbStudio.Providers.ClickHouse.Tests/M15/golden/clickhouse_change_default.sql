-- rebuildRequired: false, transactional: false

-- [alter]
ALTER TABLE shop.orders MODIFY COLUMN total Decimal(12, 2) DEFAULT 1;
