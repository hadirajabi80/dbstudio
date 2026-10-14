SELECT
    CustomerId,
    COUNT(*) AS Cnt,
    SUM(Total) AS Amount
FROM Orders
GROUP BY CustomerId
HAVING COUNT(*) > 5
    AND SUM(Total) > 1000
ORDER BY
    Amount DESC,
    CustomerId
