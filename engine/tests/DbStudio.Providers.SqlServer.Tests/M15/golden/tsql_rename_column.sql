-- rebuildRequired: false, transactional: true

-- [rename]
EXEC sys.sp_rename N'[dbo].[Orders].[Note]', N'Remarks', N'COLUMN'
GO
