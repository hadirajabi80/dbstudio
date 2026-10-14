SELECT
    COALESCE(NULLIF(TRIM(LOWER(name)), ''), 'n/a') AS clean_name,
    SUBSTR(email, INSTR(email, '@') + 1) AS domain,
    PRINTF('%05d', id) AS code
FROM customers;
