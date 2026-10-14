begin immediate transaction; update t set x = 1; savepoint sp1; rollback to savepoint sp1; release sp1; commit;
