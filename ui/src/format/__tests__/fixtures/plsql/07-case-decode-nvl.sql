select id, decode(status, 'N', 'new', 'P', 'paid', 'other') st, nvl(note, '-') note, case when total > 100 then 'big' else 'small' end sz from orders;
