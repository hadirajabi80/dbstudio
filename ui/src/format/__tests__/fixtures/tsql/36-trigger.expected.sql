CREATE TRIGGER dbo.trgOrders
ON dbo.Orders
AFTER INSERT, UPDATE
AS
BEGIN
    SET NOCOUNT ON;
    IF UPDATE(Total)
        INSERT INTO Audit (OrderId, Total)
        SELECT
            i.Id,
            i.Total
        FROM inserted i
        JOIN deleted d ON d.Id = i.Id
        WHERE i.Total <> d.Total
END
