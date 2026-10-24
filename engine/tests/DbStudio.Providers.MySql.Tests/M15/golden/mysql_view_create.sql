-- rebuildRequired: false, transactional: false
-- warning: MySQL DDL is not transactional: each statement commits on its own, so statements that ran before a failure stay applied.

-- [create]
CREATE VIEW `shop`.`order_totals` AS
SELECT customer_id, SUM(total) AS total FROM orders GROUP BY customer_id
WITH CASCADED CHECK OPTION;
