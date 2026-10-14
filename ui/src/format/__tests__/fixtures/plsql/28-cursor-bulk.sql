declare
  cursor c_orders (p_min number) is select id, total from orders where total >= p_min;
  type t_orders is table of c_orders%rowtype index by pls_integer;
  l_orders t_orders;
begin
  open c_orders(100);
  loop
    fetch c_orders bulk collect into l_orders limit 500;
    exit when l_orders.count = 0;
    forall i in 1 .. l_orders.count insert into archive (id, total) values (l_orders(i).id, l_orders(i).total);
  end loop;
  close c_orders;
end;
/
