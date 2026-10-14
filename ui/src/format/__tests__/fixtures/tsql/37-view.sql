create view dbo.vBigOrders with schemabinding as select o.Id, o.Total from dbo.Orders o where o.Total > 1000
