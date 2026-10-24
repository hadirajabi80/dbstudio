-- rebuildRequired: false, transactional: false
-- warning: MySQL DDL is not transactional: each statement commits on its own, so statements that ran before a failure stay applied.

-- [alter] Dropping column Note deletes its data.
ALTER TABLE `shop`.`Orders`
    DROP COLUMN `Note`;
