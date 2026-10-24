-- rebuildRequired: false, transactional: false

-- [comment]
ALTER TABLE shop.orders COMMENT COLUMN total 'Gross total';

-- [comment]
ALTER TABLE shop.orders MODIFY COMMENT 'All orders';
