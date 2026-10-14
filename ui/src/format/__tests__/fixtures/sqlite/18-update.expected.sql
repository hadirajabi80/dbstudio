UPDATE orders
SET
    total = total * 1.1,
    note = 'raised'
WHERE customer_id IN (
    SELECT id
    FROM customers
    WHERE vip = 1
)
RETURNING id;
