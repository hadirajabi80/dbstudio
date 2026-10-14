-- rebuildRequired: false, transactional: true

-- [create]
CREATE TABLE [dbo].[Orders] (
    [Id] int NOT NULL,
    [CustomerId] int NOT NULL,
    [OrderDate] date NOT NULL,
    [Status] nvarchar(20) NOT NULL CONSTRAINT [DF_Orders_Status] DEFAULT ('new'),
    [Total] decimal(12,2) NOT NULL CONSTRAINT [DF_Orders_Total] DEFAULT (0),
    [Note] nvarchar(200) NULL,
    CONSTRAINT [PK_Orders] PRIMARY KEY CLUSTERED ([Id]),
    CONSTRAINT [UQ_Orders_Customer_Date] UNIQUE ([CustomerId], [OrderDate]),
    CONSTRAINT [CK_Orders_Total] CHECK (Total >= 0),
    CONSTRAINT [FK_Orders_Customers] FOREIGN KEY ([CustomerId]) REFERENCES [dbo].[Customers] ([Id])
)
GO

-- [index]
CREATE NONCLUSTERED INDEX [IX_Orders_CustomerId] ON [dbo].[Orders] ([CustomerId] ASC)
GO

-- [comment]
EXEC sys.sp_addextendedproperty @name = N'MS_Description', @value = N'Customer orders', @level0type = N'SCHEMA', @level0name = N'dbo', @level1type = N'TABLE', @level1name = N'Orders'
GO

-- [comment]
EXEC sys.sp_addextendedproperty @name = N'MS_Description', @value = N'Free text', @level0type = N'SCHEMA', @level0name = N'dbo', @level1type = N'TABLE', @level1name = N'Orders', @level2type = N'COLUMN', @level2name = N'Note'
GO
