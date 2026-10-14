select customer_id, count(*) cnt, sum(total) amount from orders group by customer_id having count(*) > 5 order by amount desc;
