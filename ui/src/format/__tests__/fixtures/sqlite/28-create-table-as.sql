create table archive as select * from orders where created_at < '2020-01-01';
