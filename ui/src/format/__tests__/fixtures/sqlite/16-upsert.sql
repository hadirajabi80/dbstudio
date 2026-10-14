insert into t (a, b) values (1, 2) on conflict (a) do update set b = excluded.b, c = c + 1 where t.b <> excluded.b;
insert into t (a) values (3) on conflict do nothing;
