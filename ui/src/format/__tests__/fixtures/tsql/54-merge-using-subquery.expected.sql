MERGE dbo.CustomerStats AS tgt
USING (
    SELECT
        CustomerId,
        COUNT(*) AS Orders
    FROM dbo.Orders
    GROUP BY CustomerId
) AS src ON tgt.CustomerId = src.CustomerId
WHEN MATCHED THEN
    UPDATE SET tgt.Orders = src.Orders
WHEN NOT MATCHED THEN
    INSERT (CustomerId, Orders)
    VALUES (src.CustomerId, src.Orders);
