// Wire types of the ClickHouse module endpoints (plan-batch3 WP-CH): `GET/POST /clickhouse/{cid}/…` (engine:
// DbStudio.Providers.ClickHouse). JSON is camelCase; byte and row counts are numbers (UInt64 values above 2^53 lose
// precision, which is fine for display).

/** One partition of a MergeTree table (active parts only). */
export interface ChPartition {
  partition: string;
  partitionId: string;
  parts: number;
  rows: number;
  bytesOnDisk: number;
  dataCompressedBytes: number;
  dataUncompressedBytes: number;
  minTime: string | null;
  maxTime: string | null;
  lastModified: string | null;
}

/** One data part (`system.parts`). */
export interface ChPart {
  name: string;
  partition: string;
  partitionId: string;
  active: boolean;
  /** 'Wide' | 'Compact' | 'InMemory'. */
  partType: string;
  rows: number;
  marks: number;
  bytesOnDisk: number;
  dataCompressedBytes: number;
  dataUncompressedBytes: number;
  level: number;
  minBlock: number;
  maxBlock: number;
  modificationTime: string | null;
  disk: string | null;
}

/** `GET /clickhouse/{cid}/parts?database=&table=`. */
export interface ChPartsResponse {
  database: string;
  table: string;
  engine: string | null;
  partitionKey: string | null;
  sortingKey: string | null;
  primaryKey: string | null;
  samplingKey: string | null;
  ttl: string | null;
  totalRows: number | null;
  totalBytes: number | null;
  partitions: ChPartition[];
  parts: ChPart[];
}

/** `GET /clickhouse/{cid}/mutations` item (`system.mutations`). */
export interface ChMutation {
  database: string;
  table: string;
  mutationId: string;
  command: string;
  createTime: string | null;
  isDone: boolean;
  partsToDo: number;
  isKilled: boolean;
  latestFailReason: string | null;
  latestFailTime: string | null;
}

/** `GET /clickhouse/{cid}/merges` item (`system.merges`). */
export interface ChMerge {
  database: string;
  table: string;
  elapsedSec: number;
  /** 0..1. */
  progress: number;
  numParts: number;
  resultPartName: string;
  partitionId: string | null;
  totalSizeBytesCompressed: number;
  rowsRead: number;
  rowsWritten: number;
  memoryUsage: number;
  isMutation: boolean;
  mergeType: string | null;
}

export interface ChActionResult {
  ok: boolean;
  message: string;
}

export interface ChKillMutationRequest { database: string; table: string; mutationId: string }
export interface ChOptimizeRequest { database: string; table: string; partition?: string | null; final?: boolean; deduplicate?: boolean }
export interface ChPartitionRequest { database: string; table: string; partitionId: string }
