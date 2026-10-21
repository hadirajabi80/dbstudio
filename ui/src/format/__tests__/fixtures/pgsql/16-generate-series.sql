select g::date as day, count(o.id) from generate_series(date '2024-01-01', date '2024-01-31', interval '1 day') as g left join orders o on o.order_date = g::date group by g order by g;
