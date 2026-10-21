CREATE OR REPLACE FUNCTION order_count(p_customer INTEGER)
RETURNS INTEGER
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
declare
    v_count integer;
begin
    select count(*) into v_count from orders where customer_id = p_customer;
    return v_count;
end
$$;
