-- rebuildRequired: false, transactional: false
-- warning: MySQL DDL is not transactional: each statement commits on its own, so statements that ran before a failure stay applied.

-- [alter]
ALTER TABLE `shop`.`Orders`
    CHANGE COLUMN `Note` `Remarks` varchar(200) NULL;
