// REST endpoints offered by the Dev Tools console completion (after `METHOD `). `{index}` / `{id}` / `{alias}` are
// placeholders (snippet tab stops). Only common endpoints of Elasticsearch 7/8 and OpenSearch; `os` = OpenSearch only,
// `es` = Elasticsearch only. Lazy (imported by the console language chunk).

export interface ApiEntry {
  methods: readonly string[];
  path: string;
  doc: string;
  only?: 'es' | 'os';
}

const G = ['GET'];
const GP = ['GET', 'POST'];
const P = ['POST'];
const PU = ['PUT'];
const D = ['DELETE'];

export const API_CATALOG: readonly ApiEntry[] = [
  { methods: G, path: '/', doc: 'Cluster name and version.' },
  { methods: G, path: '/_cat/indices?v&s=index', doc: 'Indices (health, docs, size).' },
  { methods: G, path: '/_cat/health?v', doc: 'Cluster health, one line.' },
  { methods: G, path: '/_cat/nodes?v', doc: 'Nodes with heap, CPU and roles.' },
  { methods: G, path: '/_cat/shards?v', doc: 'Shards and where they live.' },
  { methods: G, path: '/_cat/aliases?v', doc: 'Aliases.' },
  { methods: G, path: '/_cat/allocation?v', doc: 'Disk use per node.' },
  { methods: G, path: '/_cat/count/{index}?v', doc: 'Document count.' },
  { methods: G, path: '/_cat/segments?v', doc: 'Lucene segments.' },
  { methods: G, path: '/_cat/thread_pool?v', doc: 'Thread pools.' },
  { methods: G, path: '/_cat/pending_tasks?v', doc: 'Pending cluster tasks.' },
  { methods: G, path: '/_cat/plugins?v', doc: 'Installed plugins.' },
  { methods: G, path: '/_cat/templates?v', doc: 'Index templates.' },
  { methods: G, path: '/_cat/recovery?v', doc: 'Shard recoveries.' },
  { methods: G, path: '/_cluster/health', doc: 'Cluster health.' },
  { methods: G, path: '/_cluster/state', doc: 'Cluster state (large).' },
  { methods: G, path: '/_cluster/stats', doc: 'Cluster statistics.' },
  { methods: ['GET', 'PUT'], path: '/_cluster/settings', doc: 'Persistent and transient settings.' },
  { methods: GP, path: '/_cluster/allocation/explain', doc: 'Why a shard is (un)assigned.' },
  { methods: G, path: '/_nodes', doc: 'Node information.' },
  { methods: G, path: '/_nodes/stats', doc: 'Node statistics.' },
  { methods: G, path: '/_nodes/hot_threads', doc: 'Busy threads.' },
  { methods: G, path: '/_tasks?detailed', doc: 'Running tasks.' },
  { methods: P, path: '/_tasks/{task_id}/_cancel', doc: 'Cancel a task.' },
  { methods: GP, path: '/_search', doc: 'Search every index.' },
  { methods: GP, path: '/{index}/_search', doc: 'Search an index.' },
  { methods: GP, path: '/{index}/_count', doc: 'Count matching documents.' },
  { methods: GP, path: '/{index}/_validate/query?explain', doc: 'Validate a query.' },
  { methods: GP, path: '/{index}/_explain/{id}', doc: 'Explain the score of a document.' },
  { methods: GP, path: '/_msearch', doc: 'Several searches (NDJSON).' },
  { methods: GP, path: '/_mget', doc: 'Several documents by id.' },
  { methods: ['GET', 'PUT'], path: '/{index}/_mapping', doc: 'Mappings of an index.' },
  { methods: ['GET', 'PUT'], path: '/{index}/_settings', doc: 'Settings of an index.' },
  { methods: G, path: '/{index}/_stats', doc: 'Index statistics.' },
  { methods: GP, path: '/{index}/_field_caps?fields=*', doc: 'Field capabilities.' },
  { methods: ['GET', 'PUT', 'DELETE', 'HEAD'], path: '/{index}', doc: 'Create, read or delete an index.' },
  { methods: ['GET', 'PUT', 'DELETE', 'HEAD'], path: '/{index}/_doc/{id}', doc: 'One document.' },
  { methods: P, path: '/{index}/_doc', doc: 'Index a document (generated id).' },
  { methods: PU, path: '/{index}/_create/{id}', doc: 'Create a document (fails when the id exists).' },
  { methods: P, path: '/{index}/_update/{id}', doc: 'Partial update ({ "doc": … } or a script).' },
  { methods: P, path: '/{index}/_delete_by_query', doc: 'Delete matching documents.' },
  { methods: P, path: '/{index}/_update_by_query', doc: 'Update matching documents.' },
  { methods: P, path: '/{index}/_refresh', doc: 'Make recent writes searchable.' },
  { methods: P, path: '/{index}/_flush', doc: 'Flush to disk.' },
  { methods: P, path: '/{index}/_forcemerge?max_num_segments=1', doc: 'Merge segments.' },
  { methods: P, path: '/{index}/_open', doc: 'Open a closed index.' },
  { methods: P, path: '/{index}/_close', doc: 'Close an index.' },
  { methods: P, path: '/{index}/_clone/{target}', doc: 'Clone an index.' },
  { methods: GP, path: '/_analyze', doc: 'Run an analyzer on text.' },
  { methods: GP, path: '/{index}/_analyze', doc: 'Run the index analyzer on text.' },
  { methods: P, path: '/_bulk', doc: 'Bulk operations (NDJSON).' },
  { methods: P, path: '/_reindex', doc: 'Copy documents between indices.' },
  { methods: P, path: '/_aliases', doc: 'Add and remove aliases.' },
  { methods: ['GET', 'PUT', 'DELETE'], path: '/{index}/_alias/{alias}', doc: 'One alias.' },
  { methods: G, path: '/_alias', doc: 'Every alias.' },
  { methods: ['GET', 'PUT', 'DELETE'], path: '/_index_template/{name}', doc: 'Composable index templates.' },
  { methods: ['GET', 'PUT', 'DELETE'], path: '/_component_template/{name}', doc: 'Component templates.' },
  { methods: ['GET', 'PUT', 'DELETE'], path: '/_template/{name}', doc: 'Legacy templates.' },
  { methods: ['GET', 'PUT', 'DELETE'], path: '/_data_stream/{name}', doc: 'Data streams.' },
  { methods: ['GET', 'PUT', 'DELETE'], path: '/_ingest/pipeline/{id}', doc: 'Ingest pipelines.' },
  { methods: GP, path: '/_ingest/pipeline/_simulate', doc: 'Try a pipeline on documents.' },
  { methods: G, path: '/_snapshot', doc: 'Snapshot repositories.' },
  { methods: GP, path: '/_resolve/index/*', doc: 'Resolve names to indices, aliases and data streams.' },
  { methods: P, path: '/_sql?format=txt', doc: 'SQL query (text table).', only: 'es' },
  { methods: P, path: '/_sql/translate', doc: 'SQL to query DSL.', only: 'es' },
  { methods: P, path: '/_plugins/_sql?format=jdbc', doc: 'SQL query.', only: 'os' },
  { methods: P, path: '/_plugins/_ppl', doc: 'PPL query.', only: 'os' },
  { methods: G, path: '/_security/_authenticate', doc: 'Who am I.', only: 'es' },
  { methods: G, path: '/_plugins/_security/authinfo', doc: 'Who am I.', only: 'os' },
  { methods: G, path: '/_license', doc: 'License.', only: 'es' },
  { methods: G, path: '/_ilm/policy', doc: 'ILM policies.', only: 'es' },
  { methods: G, path: '/_plugins/_ism/policies', doc: 'ISM policies.', only: 'os' },
  { methods: P, path: '/{index}/_pit?keep_alive=1m', doc: 'Open a point in time.', only: 'es' },
  { methods: P, path: '/_search/scroll', doc: 'Next scroll page.' },
  { methods: D, path: '/_search/scroll/_all', doc: 'Clear every scroll.' },
];

/** Monaco snippet of a catalog path: `{index}` → `${1:index}`. */
export function pathSnippet(path: string): string {
  let n = 0;
  return path.replace(/\$/g, '\\$').replace(/\{(\w+)\}/g, (_, name: string) => `\${${++n}:${name}}`);
}
