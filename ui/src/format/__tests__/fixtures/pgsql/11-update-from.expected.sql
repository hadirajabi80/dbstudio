UPDATE orders o
SET
    total = o.total * 1.1,
    status = 'paid'
FROM customers c
WHERE c.id = o.customer_id
    AND c.country_id = 3
RETURNING o.id, o.total;

UPDATE t
SET
    (a, b) = (
        SELECT
            x,
            y
        FROM u
        WHERE u.id = t.id
    );
