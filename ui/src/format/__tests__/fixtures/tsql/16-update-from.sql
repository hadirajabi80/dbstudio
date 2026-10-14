update o set o.Total = o.Total * 1.1, o.Note = 'raised' from Orders o join Customers c on c.Id = o.CustomerId where c.Vip = 1
