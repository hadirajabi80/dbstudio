/* header
   block comment */
select a, -- first column
  b /* inline */, c
from t -- the table
-- before where
where a = 1 /* trailing block */
  and b = 2

-- between statements


select 2 -- end
