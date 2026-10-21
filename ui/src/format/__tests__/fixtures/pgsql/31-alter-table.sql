alter table orders add column note text, alter column total set default 0, drop column if exists legacy, add constraint orders_total_check check (total >= 0);
alter table orders rename column note to remark;
alter table only orders alter column status type text using status::text;
