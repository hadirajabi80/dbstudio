-- rebuildRequired: false, transactional: true

-- [alter]
ALTER TABLE [dbo].[Orders] ADD [Channel] nvarchar(20) NOT NULL CONSTRAINT [DF_Orders_Channel] DEFAULT ('web')
GO
