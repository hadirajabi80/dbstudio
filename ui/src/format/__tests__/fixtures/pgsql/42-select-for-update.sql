select * from jobs where state = 'queued' order by id limit 10 for update skip locked;
select * from orders for no key update;
table customers;
values (1, 'a'), (2, 'b');
