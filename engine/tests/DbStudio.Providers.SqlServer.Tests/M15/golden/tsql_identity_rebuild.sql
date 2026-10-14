-- rebuildRequired: true, transactional: true
-- warning: Identity columns cannot be altered in place: the table is rebuilt (new table, copy with IDENTITY_INSERT, drop, rename).

-- [rebuild]
CREATE TABLE [dbo].[Orders__new] (
    [Id] int IDENTITY(1000,1) NOT NULL,
    [CustomerId] int NOT NULL,
    [OrderDate] date NOT NULL,
    [Status] nvarchar(20) NOT NULL,
    [Total] decimal(12,2) NOT NULL,
    [Note] nvarchar(200) NULL
)
GO

-- [rebuild]
SET IDENTITY_INSERT [dbo].[Orders__new] ON
GO

-- [rebuild]
INSERT INTO [dbo].[Orders__new] ([Id], [CustomerId], [OrderDate], [Status], [Total], [Note])
SELECT [Id], [CustomerId], [OrderDate], [Status], [Total], [Note]
FROM [dbo].[Orders]
GO

-- [rebuild]
SET IDENTITY_INSERT [dbo].[Orders__new] OFF
GO

-- [rebuild] Fails while foreign keys of other tables reference it; triggers and permissions of the old table are not recreated.
DROP TABLE [dbo].[Orders]
GO

-- [rebuild]
EXEC sys.sp_rename N'[dbo].[Orders__new]', N'Orders'
GO

-- [alter]
ALTER TABLE [dbo].[Orders] ADD CONSTRAINT [DF_Orders_Status] DEFAULT ('new') FOR [Status]
GO

-- [alter]
ALTER TABLE [dbo].[Orders] ADD CONSTRAINT [DF_Orders_Total] DEFAULT (0) FOR [Total]
GO

-- [alter]
ALTER TABLE [dbo].[Orders] ADD CONSTRAINT [PK_Orders] PRIMARY KEY CLUSTERED ([Id])
GO

-- [alter]
ALTER TABLE [dbo].[Orders] ADD CONSTRAINT [CK_Orders_Total] CHECK (Total >= 0)
GO

-- [alter]
ALTER TABLE [dbo].[Orders] ADD CONSTRAINT [FK_Orders_Customers] FOREIGN KEY ([CustomerId]) REFERENCES [dbo].[Customers] ([Id])
GO

-- [index]
CREATE NONCLUSTERED INDEX [IX_Orders_CustomerId] ON [dbo].[Orders] ([CustomerId] ASC)
GO
