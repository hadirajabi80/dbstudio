UPDATE orders o
SET
    o.total = o.total * 1.1,
    o.note = 'raised'
WHERE EXISTS (
    SELECT 1
    FROM customers c
    WHERE c.id = o.customer_id
        AND c.vip = 'Y'
);
