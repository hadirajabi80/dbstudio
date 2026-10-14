-- rebuildRequired: false, transactional: true

-- [drop]
ALTER TABLE [dbo].[Orders] DROP CONSTRAINT [DF_Orders_Status]
GO

-- [alter] Narrowing nvarchar(20) to nvarchar(10) may truncate data.
ALTER TABLE [dbo].[Orders] ALTER COLUMN [Status] nvarchar(10) NOT NULL
GO

-- [alter]
ALTER TABLE [dbo].[Orders] ADD CONSTRAINT [DF_Orders_Status] DEFAULT ('new') FOR [Status]
GO
