-- rebuildRequired: false, transactional: false
-- warning: MySQL DDL is not transactional: each statement commits on its own, so statements that ran before a failure stay applied.

-- [alter]
ALTER TABLE `shop`.`Orders`
    MODIFY COLUMN `Id` int NOT NULL FIRST,
    MODIFY COLUMN `Note` varchar(200) NULL AFTER `Id`,
    MODIFY COLUMN `CustomerId` int NOT NULL AFTER `Note`,
    MODIFY COLUMN `OrderDate` date NOT NULL AFTER `CustomerId`,
    MODIFY COLUMN `Status` varchar(20) NOT NULL DEFAULT 'new' AFTER `OrderDate`,
    MODIFY COLUMN `Total` decimal(12,2) NOT NULL DEFAULT 0 AFTER `Status`;
