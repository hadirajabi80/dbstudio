/**
 * Append-only list stored as fixed-size chunks. Appending never copies existing items, so a result set can
 * grow to millions of rows while React state only swaps a tiny wrapper object (see store/resultsReducer).
 */
const SHIFT = 11;
export const CHUNK_SIZE = 1 << SHIFT; // 2048
const MASK = CHUNK_SIZE - 1;

export class ChunkedList<T> {
  readonly chunks: T[][] = [];
  private len = 0;

  get length(): number {
    return this.len;
  }

  push(item: T): void {
    const ci = this.len >>> SHIFT;
    let chunk = this.chunks[ci];
    if (!chunk) {
      chunk = [];
      this.chunks.push(chunk);
    }
    chunk.push(item);
    this.len++;
  }

  pushAll(items: readonly T[]): void {
    for (let i = 0; i < items.length; i++) this.push(items[i]);
  }

  get(index: number): T | undefined {
    if (index < 0 || index >= this.len) return undefined;
    return this.chunks[index >>> SHIFT][index & MASK];
  }

  slice(start = 0, end = this.len): T[] {
    const out: T[] = [];
    const e = Math.min(end, this.len);
    for (let i = Math.max(0, start); i < e; i++) out.push(this.chunks[i >>> SHIFT][i & MASK]);
    return out;
  }

  toArray(): T[] {
    return this.slice(0, this.len);
  }

  *[Symbol.iterator](): IterableIterator<T> {
    for (const c of this.chunks) yield* c;
  }

  static from<T>(items: readonly T[]): ChunkedList<T> {
    const l = new ChunkedList<T>();
    l.pushAll(items);
    return l;
  }
}
