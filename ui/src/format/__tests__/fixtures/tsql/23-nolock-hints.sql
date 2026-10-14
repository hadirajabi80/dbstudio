select * from Orders with (nolock) join Customers c with (nolock, index(ix_name)) on c.Id = Orders.CustomerId
