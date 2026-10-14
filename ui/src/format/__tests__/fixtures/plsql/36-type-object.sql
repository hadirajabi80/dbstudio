create or replace type t_point as object (x number, y number, member function dist return number);
/
create or replace type body t_point as member function dist return number is begin return sqrt(x * x + y * y); end; end;
/
