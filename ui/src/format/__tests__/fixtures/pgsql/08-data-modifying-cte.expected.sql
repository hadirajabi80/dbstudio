WITH moved AS (
    DELETE FROM orders
    WHERE order_date < NOW() - INTERVAL '1 year'
    RETURNING *
)
INSERT INTO orders_archive
SELECT *
FROM moved;
