SELECT
    o.id,
    c.name
FROM orders o, customers c
WHERE o.customer_id = c.id(+)
    AND c.country_id(+) = 10;
