insert or replace into kv (k, v) values ('a', 1);
replace into kv (k, v) values ('b', 2);
insert or ignore into kv (k, v) select k, v from staging;
