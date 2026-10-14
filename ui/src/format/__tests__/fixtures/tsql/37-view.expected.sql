CREATE VIEW dbo.vBigOrders
WITH SCHEMABINDING
AS
SELECT
    o.Id,
    o.Total
FROM dbo.Orders o
WHERE o.Total > 1000
