-- rebuildRequired: false, transactional: false
-- warning: MySQL DDL is not transactional: each statement commits on its own, so statements that ran before a failure stay applied.

-- [rename] Views, routines and triggers that name the table by its old name are not updated.
RENAME TABLE `shop`.`Orders` TO `shop`.`SalesOrders`;
