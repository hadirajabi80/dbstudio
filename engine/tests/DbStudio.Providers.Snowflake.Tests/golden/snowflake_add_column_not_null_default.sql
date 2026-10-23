-- rebuildRequired: false, transactional: false

-- [alter]
ALTER TABLE PUBLIC.ORDERS ADD COLUMN CHANNEL VARCHAR(20) DEFAULT 'web' NOT NULL;
