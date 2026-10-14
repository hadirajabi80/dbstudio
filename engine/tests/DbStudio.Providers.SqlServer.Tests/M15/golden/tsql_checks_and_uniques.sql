-- rebuildRequired: false, transactional: true

-- [drop]
ALTER TABLE [dbo].[Orders] DROP CONSTRAINT [CK_Orders_Total]
GO

-- [alter]
ALTER TABLE [dbo].[Orders] ADD CONSTRAINT [UQ_Orders_Customer_Date] UNIQUE ([CustomerId], [OrderDate])
GO

-- [alter]
ALTER TABLE [dbo].[Orders] ADD CONSTRAINT [CK_Orders_Total] CHECK (Total >= 0 AND Total < 1000000)
GO
