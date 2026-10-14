with recursive cnt(x) as (select 1 union all select x + 1 from cnt where x < 10) select x from cnt;
