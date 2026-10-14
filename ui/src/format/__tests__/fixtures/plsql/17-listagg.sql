select customer_id, listagg(name, ', ') within group (order by name) names from products group by customer_id;
