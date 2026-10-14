WITH RECURSIVE cnt (x) AS (
    SELECT 1
    UNION ALL
    SELECT x + 1
    FROM cnt
    WHERE x < 10
)
SELECT x
FROM cnt;
