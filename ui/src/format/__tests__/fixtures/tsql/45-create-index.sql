create unique nonclustered index IX_Orders_Customer on dbo.Orders (CustomerId asc, OrderDate desc) include (Total, Status) where (Status = 'paid') with (online = on)
