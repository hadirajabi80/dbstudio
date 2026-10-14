CREATE TABLE IF NOT EXISTS orders (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    customer_id INTEGER NOT NULL REFERENCES customers (id) ON DELETE CASCADE,
    total REAL NOT NULL DEFAULT 0 CHECK (total >= 0),
    note TEXT COLLATE nocase,
    created_at TEXT DEFAULT (DATETIME('now')),
    UNIQUE (customer_id, created_at)
) STRICT;
