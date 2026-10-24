-- rebuildRequired: false, transactional: false
-- warning: MySQL DDL is not transactional: each statement commits on its own, so statements that ran before a failure stay applied.

-- [alter]
ALTER TABLE `shop`.`Orders`
    DROP CONSTRAINT `CK_Orders_Total`,
    ADD UNIQUE KEY `UQ_Orders_Customer_Date` (`CustomerId`, `OrderDate`),
    ADD CONSTRAINT `CK_Orders_Total` CHECK (Total >= 0 AND Total < 1000000);
