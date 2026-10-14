SELECT
    q.CustomerId,
    q.n
FROM (
    SELECT
        CustomerId,
        COUNT(*) n
    FROM Orders
    GROUP BY CustomerId
) q
WHERE q.n > 2
