do $$
begin
    raise notice 'hello; world';
end
$$;
do language plpgsql $x$ begin perform 1; end $x$;
