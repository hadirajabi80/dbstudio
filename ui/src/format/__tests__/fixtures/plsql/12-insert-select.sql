insert into archive (id, total) select id, total from orders where order_date < date '2020-01-01';
