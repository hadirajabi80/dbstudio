-- rebuildRequired: false, transactional: true

-- [comment]
EXEC sys.sp_addextendedproperty @name = N'MS_Description', @value = N'All orders', @level0type = N'SCHEMA', @level0name = N'dbo', @level1type = N'TABLE', @level1name = N'Orders'
GO

-- [comment]
EXEC sys.sp_addextendedproperty @name = N'MS_Description', @value = N'Gross total', @level0type = N'SCHEMA', @level0name = N'dbo', @level1type = N'TABLE', @level1name = N'Orders', @level2type = N'COLUMN', @level2name = N'Total'
GO
