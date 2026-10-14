select CustomerId, count(*) as Cnt, sum(Total) as Amount from Orders group by CustomerId having count(*) > 5 and sum(Total) > 1000 order by Amount desc, CustomerId
