-- rebuildRequired: false, transactional: false

-- [rename]
RENAME TOTALS TO ORDER_TOTALS;

-- [alter]
CREATE OR REPLACE FORCE VIEW SHOP.ORDER_TOTALS AS
SELECT customer_id, SUM(total) total FROM orders GROUP BY customer_id
WITH CHECK OPTION;
