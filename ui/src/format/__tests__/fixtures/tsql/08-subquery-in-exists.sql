select * from Customers c where exists (select 1 from Orders o where o.CustomerId = c.Id) and c.Id not in (select CustomerId from Blacklist)
