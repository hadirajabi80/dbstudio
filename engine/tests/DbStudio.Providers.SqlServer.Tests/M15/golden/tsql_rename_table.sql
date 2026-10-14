-- rebuildRequired: false, transactional: true

-- [rename] Renaming does not update views, procedures or triggers that reference the table.
EXEC sys.sp_rename N'[dbo].[Orders]', N'SalesOrders'
GO
