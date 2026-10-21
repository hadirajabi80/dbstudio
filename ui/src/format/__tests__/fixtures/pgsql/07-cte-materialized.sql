with big as materialized (select * from orders where total > 100), small as not materialized (select * from orders where total <= 100) select count(*) from big union all select count(*) from small;
