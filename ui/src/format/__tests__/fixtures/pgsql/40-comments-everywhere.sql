-- leading comment
select id, -- the key
    name /* inline */ , total
from orders -- source
where total > 0; -- trailing
