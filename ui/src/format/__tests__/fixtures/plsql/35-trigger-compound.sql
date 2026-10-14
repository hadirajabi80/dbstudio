create or replace trigger trg_orders_cmp for update of total on orders compound trigger
  g_count pls_integer := 0;
  before statement is begin g_count := 0; end before statement;
  after each row is begin g_count := g_count + 1; end after each row;
  after statement is begin dbms_output.put_line(g_count); end after statement;
end trg_orders_cmp;
/
