SELECT *
FROM files
WHERE name GLOB '*.sql'
    OR name LIKE '%.txt' ESCAPE '\'
    OR name REGEXP '^a';
