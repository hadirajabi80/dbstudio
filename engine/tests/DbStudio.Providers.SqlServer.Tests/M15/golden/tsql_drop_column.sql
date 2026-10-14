-- rebuildRequired: false, transactional: true

-- [drop] Dropping column Note deletes its data.
ALTER TABLE [dbo].[Orders] DROP COLUMN [Note]
GO
