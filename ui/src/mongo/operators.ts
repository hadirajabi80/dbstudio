// MongoDB operator reference for completion and hover docs (docs/PLAN-M2.md 6.3, 6.4): query operators, update-free
// projection helpers, aggregation stages, accumulators and the common expression operators. `snippet` uses Monaco
// snippet syntax (${1:x}).

export type OperatorKind = 'query' | 'queryTop' | 'stage' | 'accumulator' | 'expression' | 'projection';

export interface OperatorDoc {
  name: string;
  kind: OperatorKind;
  summary: string;
  syntax: string;
  /** Inserted text after the name (`: ${1}`); default `: ` + a value placeholder. */
  snippet?: string;
  /** Write stages ($out/$merge): disabled on read-only connections. */
  write?: boolean;
}

const q = (name: string, summary: string, syntax: string, snippet?: string): OperatorDoc => ({ name, kind: 'query', summary, syntax, snippet });
const top = (name: string, summary: string, syntax: string, snippet?: string): OperatorDoc => ({ name, kind: 'queryTop', summary, syntax, snippet });
const st = (name: string, summary: string, syntax: string, snippet: string, write = false): OperatorDoc => ({ name, kind: 'stage', summary, syntax, snippet, write });
const acc = (name: string, summary: string, syntax: string): OperatorDoc => ({ name, kind: 'accumulator', summary, syntax });
const ex = (name: string, summary: string, syntax: string): OperatorDoc => ({ name, kind: 'expression', summary, syntax });

export const QUERY_OPERATORS: OperatorDoc[] = [
  q('$eq', 'Matches values equal to a value.', '{ field: { $eq: value } }'),
  q('$ne', 'Matches values not equal to a value (and documents without the field).', '{ field: { $ne: value } }'),
  q('$gt', 'Matches values greater than a value.', '{ field: { $gt: value } }'),
  q('$gte', 'Matches values greater than or equal to a value.', '{ field: { $gte: value } }'),
  q('$lt', 'Matches values less than a value.', '{ field: { $lt: value } }'),
  q('$lte', 'Matches values less than or equal to a value.', '{ field: { $lte: value } }'),
  q('$in', 'Matches any of the values in an array.', '{ field: { $in: [v1, v2] } }', '[${1}]'),
  q('$nin', 'Matches none of the values in an array (and documents without the field).', '{ field: { $nin: [v1, v2] } }', '[${1}]'),
  q('$exists', 'Matches documents that have (true) or lack (false) the field.', '{ field: { $exists: true } }', '${1:true}'),
  q('$type', 'Matches values of a BSON type ("string", "objectId", "date", "number", …).', '{ field: { $type: "string" } }', '"${1:string}"'),
  q('$regex', 'Matches strings against a regular expression.', '{ field: { $regex: /pattern/, $options: "i" } }', '/${1}/'),
  q('$options', 'Regex flags for $regex (i, m, x, s).', '{ field: { $regex: "a", $options: "i" } }', '"${1:i}"'),
  q('$not', 'Inverts an operator expression.', '{ field: { $not: { $gt: 5 } } }', '{ ${1} }'),
  q('$elemMatch', 'Matches arrays with at least one element matching every condition.', '{ items: { $elemMatch: { qty: { $gt: 2 } } } }', '{ ${1} }'),
  q('$size', 'Matches arrays with this many elements.', '{ tags: { $size: 2 } }', '${1:0}'),
  q('$all', 'Matches arrays that contain every listed element.', '{ tags: { $all: ["a", "b"] } }', '[${1}]'),
  q('$mod', 'Matches numbers where value % divisor == remainder.', '{ qty: { $mod: [4, 0] } }', '[${1:2}, ${2:0}]'),
  q('$geoWithin', 'Matches geometries within a shape.', '{ loc: { $geoWithin: { $centerSphere: [[x, y], r] } } }', '{ ${1} }'),
  q('$near', 'Sorts by distance from a point (needs a geo index).', '{ loc: { $near: { $geometry: { type: "Point", coordinates: [x, y] } } } }', '{ ${1} }'),
  q('$geoIntersects', 'Matches geometries that intersect a GeoJSON shape.', '{ loc: { $geoIntersects: { $geometry: … } } }', '{ ${1} }'),
  q('$bitsAllSet', 'Matches numbers or binary with all the given bits set.', '{ flags: { $bitsAllSet: [1, 5] } }', '[${1}]'),
];

export const TOP_LEVEL_QUERY_OPERATORS: OperatorDoc[] = [
  top('$and', 'Matches documents that satisfy every clause.', '{ $and: [ {…}, {…} ] }', '[{ ${1} }]'),
  top('$or', 'Matches documents that satisfy at least one clause.', '{ $or: [ {…}, {…} ] }', '[{ ${1} }]'),
  top('$nor', 'Matches documents that satisfy none of the clauses.', '{ $nor: [ {…}, {…} ] }', '[{ ${1} }]'),
  top('$expr', 'Uses aggregation expressions inside a query.', '{ $expr: { $gt: ["$spent", "$budget"] } }', '{ ${1} }'),
  top('$text', 'Full-text search (needs a text index).', '{ $text: { $search: "coffee" } }', '{ \\$search: "${1}" }'),
  top('$where', 'Matches documents with a JavaScript predicate (slow; avoid).', '{ $where: "this.a > this.b" }', '"${1}"'),
  top('$jsonSchema', 'Matches documents that validate against a JSON Schema.', '{ $jsonSchema: { required: ["name"] } }', '{ ${1} }'),
  top('$comment', 'Adds a comment to the query (visible in logs and profiler).', '{ $comment: "why" }', '"${1}"'),
];

export const STAGES: OperatorDoc[] = [
  st('$match', 'Filters documents with a query.', '{ $match: { status: "paid" } }', '{\n  ${1}\n}'),
  st('$project', 'Includes, excludes or computes fields.', '{ $project: { _id: 0, name: 1 } }', '{\n  ${1:field}: 1\n}'),
  st('$group', 'Groups by a key and computes accumulators.', '{ $group: { _id: "$status", n: { $sum: 1 } } }', '{\n  _id: "\\$${1:field}",\n  ${2:count}: { \\$sum: 1 }\n}'),
  st('$sort', 'Sorts documents (1 ascending, -1 descending).', '{ $sort: { createdAt: -1 } }', '{\n  ${1:field}: ${2:-1}\n}'),
  st('$limit', 'Passes the first n documents.', '{ $limit: 10 }', '${1:10}'),
  st('$skip', 'Skips the first n documents.', '{ $skip: 10 }', '${1:10}'),
  st('$unwind', 'Outputs one document per array element.', '{ $unwind: "$items" }', '{\n  path: "\\$${1:field}",\n  preserveNullAndEmptyArrays: ${2:false}\n}'),
  st('$lookup', 'Left outer join with another collection.', '{ $lookup: { from, localField, foreignField, as } }', '{\n  from: "${1:collection}",\n  localField: "${2:field}",\n  foreignField: "${3:_id}",\n  as: "${4:joined}"\n}'),
  st('$addFields', 'Adds computed fields.', '{ $addFields: { total: { $sum: "$items.price" } } }', '{\n  ${1:field}: ${2}\n}'),
  st('$set', 'Alias of $addFields.', '{ $set: { field: expr } }', '{\n  ${1:field}: ${2}\n}'),
  st('$unset', 'Removes fields.', '{ $unset: ["a", "b"] }', '[\n  "${1:field}"\n]'),
  st('$count', 'Outputs one document with the number of input documents.', '{ $count: "n" }', '"${1:count}"'),
  st('$facet', 'Runs several sub-pipelines on the same input.', '{ $facet: { byStatus: [ … ], total: [ … ] } }', '{\n  ${1:name}: [\n    ${2}\n  ]\n}'),
  st('$bucket', 'Groups documents into ranges of a field.', '{ $bucket: { groupBy, boundaries, default, output } }', '{\n  groupBy: "\\$${1:field}",\n  boundaries: [${2:0, 100, 1000}],\n  default: "${3:other}"\n}'),
  st('$bucketAuto', 'Groups into an even number of buckets.', '{ $bucketAuto: { groupBy, buckets } }', '{\n  groupBy: "\\$${1:field}",\n  buckets: ${2:5}\n}'),
  st('$sortByCount', 'Groups by an expression and sorts by count.', '{ $sortByCount: "$status" }', '"\\$${1:field}"'),
  st('$replaceRoot', 'Replaces the document with an embedded document.', '{ $replaceRoot: { newRoot: "$address" } }', '{\n  newRoot: "\\$${1:field}"\n}'),
  st('$replaceWith', 'Alias of $replaceRoot.newRoot.', '{ $replaceWith: "$address" }', '"\\$${1:field}"'),
  st('$sample', 'Randomly selects n documents.', '{ $sample: { size: 10 } }', '{\n  size: ${1:10}\n}'),
  st('$densify', 'Fills gaps in a sequence.', '{ $densify: { field, range } }', '{\n  field: "${1:field}",\n  range: { step: ${2:1}, bounds: "full" }\n}'),
  st('$fill', 'Fills null and missing values.', '{ $fill: { output: { … } } }', '{\n  output: { ${1:field}: { method: "linear" } }\n}'),
  st('$setWindowFields', 'Window functions over partitions.', '{ $setWindowFields: { partitionBy, sortBy, output } }', '{\n  partitionBy: "\\$${1:field}",\n  sortBy: { ${2:field}: 1 },\n  output: {\n    ${3}\n  }\n}'),
  st('$graphLookup', 'Recursive lookup.', '{ $graphLookup: { from, startWith, connectFromField, connectToField, as } }', '{\n  from: "${1}",\n  startWith: "\\$${2}",\n  connectFromField: "${3}",\n  connectToField: "${4}",\n  as: "${5}"\n}'),
  st('$unionWith', 'Appends the documents of another collection.', '{ $unionWith: { coll, pipeline } }', '{\n  coll: "${1:collection}",\n  pipeline: []\n}'),
  st('$redact', 'Restricts content with $$DESCEND/$$PRUNE/$$KEEP.', '{ $redact: expr }', '{\n  ${1}\n}'),
  st('$geoNear', 'Sorts by distance (must be the first stage).', '{ $geoNear: { near, distanceField } }', '{\n  near: { type: "Point", coordinates: [${1:0}, ${2:0}] },\n  distanceField: "${3:dist}"\n}'),
  st('$documents', 'Starts a pipeline from literal documents.', '{ $documents: [ … ] }', '[\n  ${1}\n]'),
  st('$merge', 'Writes the results into a collection (merge).', '{ $merge: { into, on, whenMatched, whenNotMatched } }', '{\n  into: "${1:collection}"\n}', true),
  st('$out', 'Writes the results into a collection (replaces it).', '{ $out: "collection" }', '"${1:collection}"', true),
];

export const ACCUMULATORS: OperatorDoc[] = [
  acc('$sum', 'Sum of numeric values (or count with 1).', '{ $sum: "$qty" }'),
  acc('$avg', 'Average of numeric values.', '{ $avg: "$price" }'),
  acc('$min', 'Minimum value.', '{ $min: "$price" }'),
  acc('$max', 'Maximum value.', '{ $max: "$price" }'),
  acc('$first', 'First value in the group.', '{ $first: "$name" }'),
  acc('$last', 'Last value in the group.', '{ $last: "$name" }'),
  acc('$push', 'Array of every value.', '{ $push: "$sku" }'),
  acc('$addToSet', 'Array of the distinct values.', '{ $addToSet: "$sku" }'),
  acc('$count', 'Number of documents in the group.', '{ $count: {} }'),
  acc('$stdDevPop', 'Population standard deviation.', '{ $stdDevPop: "$x" }'),
  acc('$top', 'Top element by a sort order.', '{ $top: { sortBy: { x: -1 }, output: "$x" } }'),
  acc('$median', 'Median of numeric values (7.0+).', '{ $median: { input: "$x", method: "approximate" } }'),
];

export const EXPRESSIONS: OperatorDoc[] = [
  ex('$add', 'Adds numbers or a number to a date.', '{ $add: ["$a", "$b"] }'),
  ex('$subtract', 'Subtracts numbers or dates.', '{ $subtract: ["$a", "$b"] }'),
  ex('$multiply', 'Multiplies numbers.', '{ $multiply: ["$qty", "$price"] }'),
  ex('$divide', 'Divides numbers.', '{ $divide: ["$a", "$b"] }'),
  ex('$round', 'Rounds a number.', '{ $round: ["$x", 2] }'),
  ex('$concat', 'Concatenates strings.', '{ $concat: ["$first", " ", "$last"] }'),
  ex('$toUpper', 'Upper-cases a string.', '{ $toUpper: "$name" }'),
  ex('$toLower', 'Lower-cases a string.', '{ $toLower: "$name" }'),
  ex('$substrCP', 'Substring by code points.', '{ $substrCP: ["$s", 0, 3] }'),
  ex('$cond', 'If/then/else.', '{ $cond: { if: …, then: …, else: … } }'),
  ex('$ifNull', 'Replacement for null or missing values.', '{ $ifNull: ["$x", 0] }'),
  ex('$size', 'Number of array elements.', '{ $size: "$items" }'),
  ex('$filter', 'Filters an array.', '{ $filter: { input: "$items", cond: { $gt: ["$$this.qty", 1] } } }'),
  ex('$map', 'Transforms each array element.', '{ $map: { input: "$items", in: "$$this.sku" } }'),
  ex('$reduce', 'Folds an array.', '{ $reduce: { input, initialValue, in } }'),
  ex('$arrayElemAt', 'Element at an index.', '{ $arrayElemAt: ["$items", 0] }'),
  ex('$dateToString', 'Formats a date.', '{ $dateToString: { format: "%Y-%m-%d", date: "$createdAt" } }'),
  ex('$dateTrunc', 'Truncates a date to a unit.', '{ $dateTrunc: { date: "$createdAt", unit: "month" } }'),
  ex('$year', 'Year of a date.', '{ $year: "$createdAt" }'),
  ex('$month', 'Month of a date (1–12).', '{ $month: "$createdAt" }'),
  ex('$toString', 'Converts to a string.', '{ $toString: "$_id" }'),
  ex('$toObjectId', 'Converts a string to an ObjectId.', '{ $toObjectId: "$ref" }'),
  ex('$toDate', 'Converts to a date.', '{ $toDate: "$ts" }'),
  ex('$toInt', 'Converts to an int.', '{ $toInt: "$s" }'),
  ex('$toDouble', 'Converts to a double.', '{ $toDouble: "$s" }'),
  ex('$type', 'BSON type name of a value.', '{ $type: "$x" }'),
  ex('$eq', 'Equality comparison.', '{ $eq: ["$a", "$b"] }'),
  ex('$gt', 'Greater-than comparison.', '{ $gt: ["$a", "$b"] }'),
  ex('$lt', 'Less-than comparison.', '{ $lt: ["$a", "$b"] }'),
  ex('$in', 'Value is in an array.', '{ $in: ["$x", [1, 2]] }'),
  ex('$and', 'Logical and.', '{ $and: [expr1, expr2] }'),
  ex('$or', 'Logical or.', '{ $or: [expr1, expr2] }'),
  ex('$not', 'Logical not.', '{ $not: [expr] }'),
  ex('$literal', 'A value without expression parsing.', '{ $literal: "$notAField" }'),
  ex('$mergeObjects', 'Merges documents.', '{ $mergeObjects: ["$a", "$b"] }'),
  ex('$objectToArray', 'Document → [{k, v}] array.', '{ $objectToArray: "$doc" }'),
  ex('$getField', 'Field value by (dotted or $) name.', '{ $getField: "a.b" }'),
];

/** BSON type aliases accepted by `$type`. */
export const TYPE_ALIASES = [
  'double', 'string', 'object', 'array', 'binData', 'undefined', 'objectId', 'bool', 'date', 'null', 'regex', 'javascript',
  'int', 'timestamp', 'long', 'decimal', 'minKey', 'maxKey', 'number',
];

/** Value constructors offered in value positions. */
export const VALUE_HELPERS: { label: string; snippet: string; detail: string; types: string[] }[] = [
  { label: 'ObjectId', snippet: 'ObjectId("${1}")', detail: 'ObjectId("…")', types: ['objectId'] },
  { label: 'ISODate', snippet: 'ISODate("${1:2024-01-01T00:00:00Z}")', detail: 'ISODate("…")', types: ['date'] },
  { label: 'NumberLong', snippet: 'NumberLong("${1:0}")', detail: 'Int64', types: ['long'] },
  { label: 'NumberDecimal', snippet: 'NumberDecimal("${1:0.0}")', detail: 'Decimal128', types: ['decimal'] },
  { label: 'NumberInt', snippet: 'NumberInt(${1:0})', detail: 'Int32', types: ['int'] },
  { label: 'UUID', snippet: 'UUID("${1}")', detail: 'Binary subtype 4', types: ['binData'] },
  { label: 'BinData', snippet: 'BinData(${1:0}, "${2}")', detail: 'Binary', types: ['binData'] },
  { label: 'Timestamp', snippet: 'Timestamp(${1:0}, ${2:1})', detail: 'Timestamp', types: ['timestamp'] },
  { label: 'MinKey', snippet: 'MinKey', detail: 'MinKey', types: [] },
  { label: 'MaxKey', snippet: 'MaxKey', detail: 'MaxKey', types: [] },
];

const ALL = [...QUERY_OPERATORS, ...TOP_LEVEL_QUERY_OPERATORS, ...STAGES, ...ACCUMULATORS, ...EXPRESSIONS];

/** Hover doc of an operator name (`$gt`, `$group`…); stages win over expression operators of the same name. */
export function operatorDoc(name: string, prefer?: OperatorKind[]): OperatorDoc | undefined {
  if (prefer) {
    const hit = ALL.find((o) => o.name === name && prefer.includes(o.kind));
    if (hit) return hit;
  }
  return ALL.find((o) => o.name === name);
}

export function stageDoc(name: string): OperatorDoc | undefined {
  return STAGES.find((s) => s.name === name);
}

export const WRITE_STAGES = new Set(STAGES.filter((s) => s.write).map((s) => s.name));
