alter table orders add (note2 varchar2(100), status char(1) default 'N');
alter table orders modify (note varchar2(400));
comment on column orders.note is 'Free text';
