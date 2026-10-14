SELECT
    Id,
    Name
FROM Customers
FOR JSON PATH, ROOT('customers')
