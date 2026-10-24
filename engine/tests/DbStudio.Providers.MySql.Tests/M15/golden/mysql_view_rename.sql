-- rebuildRequired: false, transactional: false
-- warning: MySQL DDL is not transactional: each statement commits on its own, so statements that ran before a failure stay applied.

-- [rename]
RENAME TABLE `shop`.`totals` TO `shop`.`order_totals`;

-- [alter]
CREATE OR REPLACE VIEW `shop`.`order_totals` AS
SELECT customer_id, SUM(total) AS total FROM orders GROUP BY customer_id
WITH CASCADED CHECK OPTION;
