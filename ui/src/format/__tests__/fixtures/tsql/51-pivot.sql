select * from (select Year, Quarter, Amount from Sales) s pivot (sum(Amount) for Quarter in ([Q1], [Q2], [Q3], [Q4])) p
