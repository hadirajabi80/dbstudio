-- rebuildRequired: false, transactional: false
-- warning: MySQL DDL is not transactional: each statement commits on its own, so statements that ran before a failure stay applied.

-- [create]
CREATE TABLE `shop`.`Orders` (
    `Id` int NOT NULL,
    `CustomerId` int NOT NULL,
    `OrderDate` date NOT NULL,
    `Status` varchar(20) NOT NULL DEFAULT 'new',
    `Total` decimal(12,2) NOT NULL DEFAULT 0,
    `Note` varchar(200) NULL COMMENT 'Free text',
    PRIMARY KEY (`Id`),
    UNIQUE KEY `UQ_Orders_Customer_Date` (`CustomerId`, `OrderDate`),
    INDEX `IX_Orders_CustomerId` (`CustomerId`),
    CONSTRAINT `CK_Orders_Total` CHECK (Total >= 0),
    CONSTRAINT `FK_Orders_Customers` FOREIGN KEY (`CustomerId`) REFERENCES `shop`.`Customers` (`Id`)
) COMMENT = 'Customer orders';
