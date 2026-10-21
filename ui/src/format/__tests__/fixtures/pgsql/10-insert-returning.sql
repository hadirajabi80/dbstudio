insert into orders (customer_id, total, status) values (1, 10.5, 'new'), (2, 20, 'paid') returning *;
insert into orders (customer_id, total) select id, 0 from customers where id > 10 returning id;
insert into log default values returning id;
