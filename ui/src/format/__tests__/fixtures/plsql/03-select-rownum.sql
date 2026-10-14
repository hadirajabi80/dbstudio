select * from (select id, total from orders order by total desc) where rownum <= 10;
