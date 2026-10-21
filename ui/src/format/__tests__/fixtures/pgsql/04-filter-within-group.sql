select count(*) filter (where status = 'paid') as paid, percentile_cont(0.5) within group (order by total) as median, string_agg(name, ', ' order by name) from orders;
