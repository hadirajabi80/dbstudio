create or replace function trg_orders_check_fn() returns trigger language plpgsql as $$
begin
    if new.total < 0 then
        raise exception 'negative total';
    end if;
    return new;
end
$$;
create or replace trigger trg_orders_check before insert or update of total on orders for each row when (new.total is not null) execute function trg_orders_check_fn();
