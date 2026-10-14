-- rebuildRequired: false, transactional: true

-- [create]
CREATE OR ALTER VIEW [Sales].[OrderTotals]
WITH SCHEMABINDING
AS
SELECT CustomerId, SUM(Total) AS Total FROM dbo.Orders GROUP BY CustomerId
GO
