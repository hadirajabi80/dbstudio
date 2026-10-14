create function dbo.fnOrders (@cid int) returns table as return (select Id, Total from dbo.Orders where CustomerId = @cid)
