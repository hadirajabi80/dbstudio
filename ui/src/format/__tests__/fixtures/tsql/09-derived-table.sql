select q.CustomerId, q.n from (select CustomerId, count(*) n from Orders group by CustomerId) q where q.n > 2
