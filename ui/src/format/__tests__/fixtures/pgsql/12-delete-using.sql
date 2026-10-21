delete from orders o using customers c where c.id = o.customer_id and c.email is null returning o.*;
