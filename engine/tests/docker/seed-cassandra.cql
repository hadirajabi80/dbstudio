-- Cassandra "shop" keyspace seed (plan-batch3 WP-CS), run by the one-shot cassandra-seed service (cqlsh -f).
-- WP0 placeholder: WP-CS fills it.
CREATE KEYSPACE IF NOT EXISTS shop WITH replication = {'class': 'SimpleStrategy', 'replication_factor': 1};
