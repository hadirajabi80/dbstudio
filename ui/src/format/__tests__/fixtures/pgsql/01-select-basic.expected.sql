SELECT
    id,
    name,
    email
FROM customers
WHERE country_id = 1
ORDER BY name
LIMIT 10
OFFSET 20;
