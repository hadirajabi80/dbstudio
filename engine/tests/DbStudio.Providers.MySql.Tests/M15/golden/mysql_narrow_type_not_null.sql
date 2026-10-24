-- rebuildRequired: false, transactional: false
-- warning: MySQL DDL is not transactional: each statement commits on its own, so statements that ran before a failure stay applied.

-- [alter] Narrowing varchar(20) to VARCHAR(10) fails (strict mode) or truncates values that do not fit.
ALTER TABLE `shop`.`Orders`
    MODIFY COLUMN `Status` VARCHAR(10) NOT NULL DEFAULT 'new';
