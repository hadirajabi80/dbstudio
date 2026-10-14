-- rebuildRequired: false, transactional: true

-- [drop]
DROP INDEX [IX_Orders_CustomerId] ON [dbo].[Orders]
GO

-- [index]
CREATE NONCLUSTERED INDEX [IX_Orders_Date_Status] ON [dbo].[Orders] ([OrderDate] DESC, [Status] ASC)
GO
