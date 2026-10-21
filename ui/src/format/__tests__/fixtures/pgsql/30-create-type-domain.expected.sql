CREATE TYPE order_status AS ENUM (
    'new',
    'paid',
    'shipped',
    'cancelled'
);

CREATE DOMAIN email_address AS TEXT CHECK (value ~* '^[^@]+@[^@]+$');
CREATE TYPE money_pair AS (amount NUMERIC, currency CHAR(3));
