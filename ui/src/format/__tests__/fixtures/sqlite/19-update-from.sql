update inventory set qty = qty - s.qty from (select item_id, sum(qty) qty from sales group by item_id) s where s.item_id = inventory.item_id;
