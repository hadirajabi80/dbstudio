SELECT
    LEVEL,
    LPAD(' ', 2 * LEVEL) || name AS tree
FROM employees
START WITH manager_id IS NULL
CONNECT BY PRIOR id = manager_id
ORDER SIBLINGS BY name;
