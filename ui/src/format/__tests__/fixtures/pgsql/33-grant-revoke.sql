grant select, insert, update on all tables in schema public to app_user;
revoke delete on orders from app_user;
grant usage on schema sales to reporting;
