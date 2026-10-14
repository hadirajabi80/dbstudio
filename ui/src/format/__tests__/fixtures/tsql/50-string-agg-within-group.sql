select CustomerId, string_agg(Name, ', ') within group (order by Name) as Names from Customers group by CustomerId
