DELETE FROM orders
WHERE total < 0
RETURNING id INTO :deleted_id;
