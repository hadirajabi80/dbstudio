-- rebuildRequired: false, transactional: false
-- warning: MySQL DDL is not transactional: each statement commits on its own, so statements that ran before a failure stay applied.

-- [alter]
ALTER TABLE `shop`.`Orders`
    MODIFY COLUMN `Total` decimal(12,2) NOT NULL DEFAULT 0 COMMENT 'Gross total',
    COMMENT = 'All orders';
