SELECT *
FROM Customers c
WHERE EXISTS (
    SELECT 1
    FROM Orders o
    WHERE o.CustomerId = c.Id
)
    AND c.Id NOT IN (
        SELECT CustomerId
        FROM Blacklist
    )
