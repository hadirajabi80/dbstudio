select customer_id, count(*) as cnt, sum(total) as amount from orders group by customer_id having count(*) > 5 order by amount desc;
