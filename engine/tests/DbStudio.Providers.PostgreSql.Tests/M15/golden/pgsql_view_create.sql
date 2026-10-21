-- rebuildRequired: false, transactional: true

-- [create]
CREATE VIEW sales.order_totals AS
SELECT customer_id, sum(total) AS total FROM public.orders GROUP BY customer_id
WITH CASCADED CHECK OPTION;
