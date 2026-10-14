CREATE FUNCTION dbo.fnOrders (@cid INT)
RETURNS TABLE
AS
RETURN (
    SELECT
        Id,
        Total
    FROM dbo.Orders
    WHERE CustomerId = @cid
)
