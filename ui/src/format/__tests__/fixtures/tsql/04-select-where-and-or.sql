SELECT Id FROM Orders WHERE Status = 'paid' AND (Total > 100 OR Discount IS NOT NULL) AND OrderDate BETWEEN '2026-01-01' AND '2026-12-31'
