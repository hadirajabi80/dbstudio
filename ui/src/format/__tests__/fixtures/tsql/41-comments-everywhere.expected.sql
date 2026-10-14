/* header
   block comment */
SELECT
    a, -- first column
    b /* inline */,
    c
FROM t -- the table
-- before where
WHERE a = 1 /* trailing block */
    AND b = 2

-- between statements

SELECT 2 -- end
