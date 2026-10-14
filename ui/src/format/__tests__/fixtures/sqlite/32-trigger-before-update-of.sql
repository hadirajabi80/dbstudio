create temp trigger if not exists trg_upd before update of total, status on orders begin select raise(abort, 'locked') where old.status = 'closed'; end;
