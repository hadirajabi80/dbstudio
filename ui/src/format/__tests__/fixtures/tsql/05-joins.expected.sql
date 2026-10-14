SELECT *
FROM Orders o
INNER JOIN Customers c ON c.Id = o.CustomerId
LEFT OUTER JOIN Countries co ON co.Id = c.CountryId
    AND co.Active = 1
CROSS APPLY (
    SELECT TOP 1 *
    FROM OrderLines ol
    WHERE ol.OrderId = o.Id
    ORDER BY ol.Qty DESC
) x
OUTER APPLY dbo.fnTax(o.Id) t
