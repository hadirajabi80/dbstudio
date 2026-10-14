-- rebuildRequired: false, transactional: true

-- [drop]
ALTER TABLE [dbo].[Orders] DROP CONSTRAINT [DF_Orders_Total]
GO

-- [alter]
ALTER TABLE [dbo].[Orders] ADD CONSTRAINT [DF_Orders_Total] DEFAULT (1) FOR [Total]
GO
