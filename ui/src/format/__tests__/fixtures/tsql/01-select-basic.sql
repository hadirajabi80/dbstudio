select c.Name, o.Total from Customers c join Orders o on o.CustomerId = c.Id where o.Total > 100 order by o.Total desc
