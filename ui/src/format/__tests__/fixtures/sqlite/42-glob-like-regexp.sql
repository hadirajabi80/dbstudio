select * from files where name glob '*.sql' or name like '%.txt' escape '\' or name regexp '^a';
