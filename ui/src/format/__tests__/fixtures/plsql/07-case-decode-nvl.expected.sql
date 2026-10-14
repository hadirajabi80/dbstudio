SELECT
    id,
    DECODE(status, 'N', 'new', 'P', 'paid', 'other') st,
    NVL(note, '-') note,
    CASE WHEN total > 100 THEN 'big' ELSE 'small' END sz
FROM orders;
