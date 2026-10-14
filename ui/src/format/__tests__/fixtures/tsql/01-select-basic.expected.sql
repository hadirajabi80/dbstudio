SELECT
    c.Name,
    o.Total
FROM Customers c
JOIN Orders o ON o.CustomerId = c.Id
WHERE o.Total > 100
ORDER BY o.Total DESC
