create or replace function order_count(p_customer integer) returns integer language plpgsql stable security definer set search_path = public as $$
declare
    v_count integer;
begin
    select count(*) into v_count from orders where customer_id = p_customer;
    return v_count;
end
$$;
