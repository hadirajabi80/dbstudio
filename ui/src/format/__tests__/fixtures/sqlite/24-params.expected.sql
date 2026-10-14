SELECT *
FROM orders
WHERE customer_id = ?1
    AND status = :status
    AND total > @min
    AND note LIKE $pattern;
