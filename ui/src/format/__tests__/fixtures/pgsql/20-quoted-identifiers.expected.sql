SELECT
    "Value",
    m."id",
    "Weird ""Name"""
FROM "MixedCase" m
WHERE m."Value" ILIKE 'a%';
