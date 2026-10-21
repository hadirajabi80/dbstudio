SELECT *
FROM orders
WHERE customer_id = $1
    AND status = $2::order_status
    AND total > :min_total
    AND note LIKE @pattern;
