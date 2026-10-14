-- rebuildRequired: false, transactional: true

-- [alter]
ALTER TABLE "Orders" ADD COLUMN "Channel" TEXT NOT NULL DEFAULT 'web';
