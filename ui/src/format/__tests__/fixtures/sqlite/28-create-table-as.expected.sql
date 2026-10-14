CREATE TABLE archive AS
SELECT *
FROM orders
WHERE created_at < '2020-01-01';
