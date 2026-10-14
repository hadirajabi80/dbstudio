select q.customer_id, q.n from (select customer_id, count(*) n from orders group by customer_id) q where q.n > 2;
