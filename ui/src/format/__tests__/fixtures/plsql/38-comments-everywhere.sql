/* header
   block */
select a, -- first
  b /* inline */, c
from t -- table
-- before where
where a = 1
  and b = 2;

-- between statements


begin
  -- inside block
  null; -- trailing
  /* own line block */
end;
/
