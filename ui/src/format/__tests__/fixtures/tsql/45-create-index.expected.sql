CREATE UNIQUE NONCLUSTERED INDEX IX_Orders_Customer ON dbo.Orders (CustomerId ASC, OrderDate DESC) INCLUDE (
    Total,
    Status
) WHERE (Status = 'paid') WITH (online = ON)
