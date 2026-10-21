select customer_id, status, sum(total) from orders group by grouping sets ((customer_id), (status), ()) having sum(total) > 0;
select a, b from t group by rollup (a, b);
