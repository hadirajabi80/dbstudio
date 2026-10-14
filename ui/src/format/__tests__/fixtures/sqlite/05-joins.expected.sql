SELECT *
FROM orders o
INNER JOIN customers c ON c.id = o.customer_id
LEFT JOIN countries co ON co.id = c.country_id
    AND co.active = 1
CROSS JOIN settings s
NATURAL JOIN extras;
