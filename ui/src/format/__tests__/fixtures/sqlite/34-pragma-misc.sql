pragma foreign_keys = on;
pragma journal_mode = wal;
vacuum;
analyze orders;
attach database 'other.db' as other;
detach database other;
