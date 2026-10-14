insert into Archive (Id, Total) select Id, Total from Orders where OrderDate < '2020-01-01'
