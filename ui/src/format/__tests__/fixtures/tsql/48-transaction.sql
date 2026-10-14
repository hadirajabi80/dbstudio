begin transaction; update t set x = 1; save transaction sp1; rollback transaction sp1; commit transaction;
