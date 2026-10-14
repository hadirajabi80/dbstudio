select coalesce(nullif(trim(lower(name)), ''), 'n/a') as clean_name, substr(email, instr(email, '@') + 1) as domain, printf('%05d', id) as code from customers;
