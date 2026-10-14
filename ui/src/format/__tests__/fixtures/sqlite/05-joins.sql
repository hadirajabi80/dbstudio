select * from orders o inner join customers c on c.id = o.customer_id left join countries co on co.id = c.country_id and co.active = 1 cross join settings s natural join extras;
