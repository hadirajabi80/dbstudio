DO $$
begin
    raise notice 'hello; world';
end
$$;

DO LANGUAGE plpgsql $x$ begin perform 1; end $x$;
