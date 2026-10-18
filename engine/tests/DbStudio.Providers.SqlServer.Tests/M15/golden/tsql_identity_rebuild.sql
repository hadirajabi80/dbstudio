-- rebuildRequired: true, transactional: true
-- warning: Identity columns cannot be altered in place: the table is rebuilt (new table, copy with IDENTITY_INSERT, drop, rename).
-- warning: The firing order of trigger TR_Orders_Audit (sp_settriggerorder) is not carried over.
-- warning: Extended property Owner on table is not carried over.

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

-- [drop] Foreign key FK_OrderLines_Orders of [Sales].[OrderLines] references the table: it is dropped here and recreated after the rebuild.
ALTER TABLE [Sales].[OrderLines] DROP CONSTRAINT [FK_OrderLines_Orders]
GO

-- [drop] Foreign key FK_Audit_Orders of [dbo].[Audit] references the table: it is dropped here and recreated after the rebuild.
ALTER TABLE [dbo].[Audit] DROP CONSTRAINT [FK_Audit_Orders]
GO

-- [rebuild] The old table is dropped; its rows were copied above. Its triggers (TR_Orders_Stamp, TR_Orders_Audit) are recreated after the rename.
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

-- [comment]
EXEC sys.sp_addextendedproperty @name = N'MS_Description', @value = N'Free text', @level0type = N'SCHEMA', @level0name = N'dbo', @level1type = N'TABLE', @level1name = N'Orders', @level2type = N'COLUMN', @level2name = N'Note'
GO

-- [alter]
ALTER TABLE [Sales].[OrderLines] WITH CHECK ADD CONSTRAINT [FK_OrderLines_Orders] FOREIGN KEY ([OrderId]) REFERENCES [dbo].[Orders] ([Id]) ON DELETE CASCADE
GO

-- [alter]
ALTER TABLE [dbo].[Audit] WITH NOCHECK ADD CONSTRAINT [FK_Audit_Orders] FOREIGN KEY ([OrderId]) REFERENCES [dbo].[Orders] ([Id])
GO

-- [alter]
ALTER TABLE [dbo].[Audit] NOCHECK CONSTRAINT [FK_Audit_Orders]
GO

-- [create] Recreates trigger TR_Orders_Stamp from its stored definition.
CREATE TRIGGER [dbo].[TR_Orders_Stamp] ON [dbo].[Orders] AFTER UPDATE AS
BEGIN
    SET NOCOUNT ON;
END
GO

-- [create] Recreates trigger TR_Orders_Audit from its stored definition.
CREATE TRIGGER dbo.TR_Orders_Audit ON dbo.Orders AFTER DELETE AS RETURN
GO

-- [alter]
DISABLE TRIGGER [dbo].[TR_Orders_Audit] ON [dbo].[Orders]
GO

-- [alter]
GRANT SELECT ON [dbo].[Orders] TO [reporting]
GO

-- [alter]
GRANT UPDATE ([Note]) ON [dbo].[Orders] TO [clerks] WITH GRANT OPTION
GO

-- [alter]
DENY DELETE ON [dbo].[Orders] TO [clerks]
GO
