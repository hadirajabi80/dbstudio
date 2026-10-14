with big as (select Id, Total as Amt from Orders where Total > 100), cust as (select * from Customers) select b.Id, c.Name from big b join cust c on c.Id = b.Id
