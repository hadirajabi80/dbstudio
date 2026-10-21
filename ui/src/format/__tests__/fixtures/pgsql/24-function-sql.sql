create or replace function fn_tax(amount numeric, rate numeric default 0.2) returns numeric language sql immutable strict parallel safe as $$ select amount * rate $$;
