select level, lpad(' ', 2 * level) || name as tree from employees start with manager_id is null connect by prior id = manager_id order siblings by name;
