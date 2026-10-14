/* header
   block */
SELECT
    a, -- first
    b /* inline */,
    c
FROM t -- table
-- before where
WHERE a = 1
    AND b = 2;

-- between statements

SELECT 2; -- end
