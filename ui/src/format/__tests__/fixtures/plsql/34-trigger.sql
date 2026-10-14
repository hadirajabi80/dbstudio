create or replace trigger trg_orders_biu before insert or update of total on orders for each row when (new.total > 0) declare v_now date := sysdate; begin if inserting then :new.created_at := v_now; end if; :new.updated_at := v_now; end;
/
