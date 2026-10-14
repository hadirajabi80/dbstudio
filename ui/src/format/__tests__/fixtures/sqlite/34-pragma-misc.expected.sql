PRAGMA foreign_keys = ON;
PRAGMA journal_mode = wal;
VACUUM;
ANALYZE orders;
ATTACH DATABASE 'other.db' AS other;
DETACH DATABASE other;
