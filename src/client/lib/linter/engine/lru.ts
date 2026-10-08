/**
 * A size-aware least-recently-used cache with the handful of `lru-cache` methods the lint engine
 * uses: `get`, `set`, `peek`, `delete`, and the `maxEntrySize` rule that keeps one oversized
 * document from evicting everything else when it is stored.
 */
export type LruCacheOptions<KeyType, ValueType> = {
  maxSize: number,
  maxEntrySize?: number,
  sizeCalculation?: (value: ValueType, key: KeyType) => number,
}

export class LRUCache<KeyType, ValueType> {
  private readonly entries = new Map<KeyType, {value: ValueType, size: number}>();
  private totalSize = 0;

  constructor(private readonly options: LruCacheOptions<KeyType, ValueType>) {}

  get size(): number {
    return this.entries.size;
  }

  get calculatedSize(): number {
    return this.totalSize;
  }

  private sizeOf(value: ValueType, key: KeyType): number {
    return this.options.sizeCalculation ? this.options.sizeCalculation(value, key) : 1;
  }

  peek(key: KeyType): ValueType | undefined {
    return this.entries.get(key)?.value;
  }

  get(key: KeyType): ValueType | undefined {
    const entry = this.entries.get(key);
    if (!entry) {
      return undefined;
    }

    this.entries.delete(key);
    this.entries.set(key, entry);

    return entry.value;
  }

  set(key: KeyType, value: ValueType): this {
    const size = this.sizeOf(value, key);
    if (this.options.maxEntrySize !== undefined && size > this.options.maxEntrySize) {
      this.delete(key);

      return this;
    }

    this.delete(key);
    this.entries.set(key, {value, size});
    this.totalSize += size;
    this.evict();

    return this;
  }

  delete(key: KeyType): boolean {
    const entry = this.entries.get(key);
    if (!entry) {
      return false;
    }

    this.entries.delete(key);
    this.totalSize -= entry.size;

    return true;
  }

  clear(): void {
    this.entries.clear();
    this.totalSize = 0;
  }

  private evict(): void {
    for (const [key, entry] of this.entries) {
      if (this.totalSize <= this.options.maxSize) {
        break;
      }

      this.entries.delete(key);
      this.totalSize -= entry.size;
    }
  }
}
