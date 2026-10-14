begin
<<outer_loop>>
for i in 1..3 loop
  <<inner_loop>>
  for j in 1..3 loop
    exit outer_loop when i * j > 4;
  end loop inner_loop;
end loop outer_loop;
end;
/
