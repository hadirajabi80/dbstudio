-- rebuildRequired: false, transactional: false
-- warning: SHOP.TOTALS is replaced by a new view SHOP.ORDER_TOTALS: grants on the old view are not carried over.

-- [create]
CREATE FORCE VIEW SHOP.ORDER_TOTALS AS
SELECT customer_id, SUM(total) total FROM orders GROUP BY customer_id
WITH CHECK OPTION;

-- [drop]
DROP VIEW SHOP.TOTALS;
