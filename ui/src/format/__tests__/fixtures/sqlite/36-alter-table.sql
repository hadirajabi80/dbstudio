alter table orders add column note2 text; alter table orders rename column note2 to remark; alter table orders rename to orders_old; alter table orders_old drop column remark;
