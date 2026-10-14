SELECT
    CustomerId,
    STRING_AGG(Name, ', ') WITHIN GROUP (ORDER BY Name) AS Names
FROM Customers
GROUP BY CustomerId
