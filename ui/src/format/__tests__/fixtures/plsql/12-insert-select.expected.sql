INSERT INTO archive (id, total)
SELECT
    id,
    total
FROM orders
WHERE order_date < DATE '2020-01-01';
