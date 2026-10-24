-- rebuildRequired: false, transactional: false
-- warning: MySQL DDL is not transactional: each statement commits on its own, so statements that ran before a failure stay applied.

-- [alter]
ALTER TABLE `shop`.`Orders`
    DROP INDEX `IX_Orders_CustomerId`,
    ADD INDEX `IX_Orders_Date_Status` (`OrderDate` DESC, `Status`);
