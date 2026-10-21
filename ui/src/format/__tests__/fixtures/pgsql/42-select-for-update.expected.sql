SELECT *
FROM jobs
WHERE state = 'queued'
ORDER BY id
LIMIT 10
FOR UPDATE SKIP LOCKED;

SELECT *
FROM orders
FOR NO KEY UPDATE;

TABLE customers;
VALUES (1, 'a'), (2, 'b');
