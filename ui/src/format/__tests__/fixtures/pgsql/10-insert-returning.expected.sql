INSERT INTO orders (customer_id, total, status)
VALUES
    (1, 10.5, 'new'),
    (2, 20, 'paid')
RETURNING *;

INSERT INTO orders (customer_id, total)
SELECT
    id,
    0
FROM customers
WHERE id > 10
RETURNING id;

INSERT INTO log DEFAULT VALUES
RETURNING id;
