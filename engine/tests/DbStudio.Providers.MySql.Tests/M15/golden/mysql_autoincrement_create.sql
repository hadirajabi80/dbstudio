-- rebuildRequired: false, transactional: false
-- warning: MySQL DDL is not transactional: each statement commits on its own, so statements that ran before a failure stay applied.

-- [create]
CREATE TABLE `shop`.`invoices` (
    `id` bigint unsigned NOT NULL AUTO_INCREMENT,
    `amount` decimal(12,2) NOT NULL,
    `created` timestamp NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
    PRIMARY KEY (`id`)
);
