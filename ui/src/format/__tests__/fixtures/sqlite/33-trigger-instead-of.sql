create trigger trg_v instead of delete on v_big begin delete from orders where id = old.id; end;
