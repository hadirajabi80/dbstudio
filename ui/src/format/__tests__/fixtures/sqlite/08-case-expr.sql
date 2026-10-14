select id, case status when 'n' then 'new' when 'p' then 'paid' else 'other' end as st, case when total > 100 then 1 else 0 end as big from orders;
