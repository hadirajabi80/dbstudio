INSERT INTO Archive (Id, Total)
SELECT
    Id,
    Total
FROM Orders
WHERE OrderDate < '2020-01-01'
