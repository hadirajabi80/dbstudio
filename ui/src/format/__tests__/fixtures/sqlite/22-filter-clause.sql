select count(*) filter (where total > 100) as big, count(*) as total from orders;
