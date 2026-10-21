insert into customers (id, name, email) values (1, 'Ann', 'ann@example.com') on conflict (id) do update set name = excluded.name, email = excluded.email where customers.email is distinct from excluded.email returning id, name;
insert into tags (name) values ('x') on conflict do nothing;
insert into tags (name) values ('y') on conflict on constraint tags_name_key do nothing;
