CREATE OR REPLACE FUNCTION trg_orders_check_fn()
RETURNS TRIGGER
LANGUAGE plpgsql
AS $$
begin
    if new.total < 0 then
        raise exception 'negative total';
    end if;
    return new;
end
$$;

CREATE OR REPLACE TRIGGER trg_orders_check
BEFORE INSERT OR UPDATE OF total
ON orders
FOR EACH ROW
WHEN (new.total IS NOT NULL)
EXECUTE FUNCTION trg_orders_check_fn();
