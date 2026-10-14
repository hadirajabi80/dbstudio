select Id, case Status when 'n' then 'new' when 'p' then 'paid' else 'other' end as StatusText, case when Total > 100 then 1 else 0 end as Big from Orders
