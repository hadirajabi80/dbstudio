-- rebuildRequired: false, transactional: true
-- warning: CREATE OR REPLACE can only append columns; drop the view first to remove or retype columns.

-- [rename]
ALTER VIEW sales.totals RENAME TO order_totals;

-- [alter]
CREATE OR REPLACE VIEW sales.order_totals AS
SELECT customer_id, sum(total) AS total FROM public.orders GROUP BY customer_id
WITH CASCADED CHECK OPTION;
