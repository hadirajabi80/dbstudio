create type order_status as enum ('new', 'paid', 'shipped', 'cancelled');
create domain email_address as text check (value ~* '^[^@]+@[^@]+$');
create type money_pair as (amount numeric, currency char(3));
