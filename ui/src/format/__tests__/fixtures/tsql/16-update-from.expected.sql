UPDATE o
SET
    o.Total = o.Total * 1.1,
    o.Note = 'raised'
FROM Orders o
JOIN Customers c ON c.Id = o.CustomerId
WHERE c.Vip = 1
