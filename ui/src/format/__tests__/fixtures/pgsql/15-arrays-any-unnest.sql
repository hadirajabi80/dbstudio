select u.val, u.ord, tags[1], tags[2:3], array_length(tags, 1) from extra_types, unnest(tags) with ordinality as u(val, ord) where 'x' = any(tags) and id <> all(array[1, 2, 3]);
