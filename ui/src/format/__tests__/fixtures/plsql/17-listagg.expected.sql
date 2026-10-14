SELECT
    customer_id,
    LISTAGG(name, ', ') WITHIN GROUP (ORDER BY name) names
FROM products
GROUP BY customer_id;
