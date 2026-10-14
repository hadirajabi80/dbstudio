set serveroutput on
prompt Creating things...
define v_owner = SCOTT
SELECT *
FROM dual;

exec dbms_output.put_line('hi')
show errors
@other_script.sql
