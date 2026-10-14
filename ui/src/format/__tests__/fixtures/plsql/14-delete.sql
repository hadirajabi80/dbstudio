delete from orders where total < 0 returning id into :deleted_id;
