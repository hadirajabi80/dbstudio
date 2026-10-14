SELECT *
FROM Orders WITH (NOLOCK)
JOIN Customers c WITH (NOLOCK, INDEX(ix_name)) ON c.Id = Orders.CustomerId
