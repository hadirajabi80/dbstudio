SELECT DISTINCT ON (customer_id)
    customer_id,
    order_date,
    total
FROM orders
ORDER BY
    customer_id,
    order_date DESC;
