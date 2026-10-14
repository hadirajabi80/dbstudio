WITH big AS (
    SELECT
        Id,
        Total AS Amt
    FROM Orders
    WHERE Total > 100
), cust AS (
    SELECT *
    FROM Customers
)
SELECT
    b.Id,
    c.Name
FROM big b
JOIN cust c ON c.Id = b.Id
