-- rebuildRequired: false, transactional: false
-- warning: MySQL DDL is not transactional: each statement commits on its own, so statements that ran before a failure stay applied.

-- [alter]
ALTER TABLE `shop`.`Orders`
    ADD COLUMN `TotalWithTax` decimal(12,2) GENERATED ALWAYS AS (Total * 1.19) STORED AFTER `Note`,
    ADD COLUMN `NoteLength` int GENERATED ALWAYS AS (CHAR_LENGTH(Note)) VIRTUAL AFTER `TotalWithTax`;
