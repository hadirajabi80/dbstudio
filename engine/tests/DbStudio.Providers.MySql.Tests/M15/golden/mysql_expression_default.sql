-- rebuildRequired: false, transactional: false
-- warning: MySQL DDL is not transactional: each statement commits on its own, so statements that ran before a failure stay applied.

-- [create]
CREATE TABLE `shop`.`events` (
    `id` char(36) NOT NULL DEFAULT (uuid()),
    `payload` json NULL DEFAULT ('{}'),
    `flags` bit(4) NOT NULL DEFAULT b'0000',
    PRIMARY KEY (`id`)
);
