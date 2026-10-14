with big as (select id, total from orders where total > 100), cust as (select * from customers) select b.id, c.name from big b join cust c on c.id = b.id;
