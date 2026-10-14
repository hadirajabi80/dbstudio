create view if not exists v_big as select id, total from orders where total > 1000;
