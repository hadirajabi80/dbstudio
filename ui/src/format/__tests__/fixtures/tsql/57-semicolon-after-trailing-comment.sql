select Id from dbo.Customers -- everyone
;
with c as (select 1 as x) select x from c;
