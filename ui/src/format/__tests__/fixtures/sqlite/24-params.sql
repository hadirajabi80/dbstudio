select * from orders where customer_id = ?1 and status = :status and total > @min and note like $pattern;
