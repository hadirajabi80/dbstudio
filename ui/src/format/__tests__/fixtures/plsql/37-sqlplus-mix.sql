set serveroutput on
prompt Creating things...
define v_owner = SCOTT
select * from dual;
exec dbms_output.put_line('hi')
show errors
@other_script.sql
