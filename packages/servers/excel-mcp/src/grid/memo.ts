/**
 * Caches a pure function under the key `keyOf` gives its arguments.
 *
 * Guard: the server is long-lived and keys come from files and callers, so
 * the cache is dropped whole once it holds `capacity` keys instead of growing
 * with every workbook it has ever read.
 */
export function boundedMemo<A extends readonly unknown[], T>(
  compute: (...args: A) => T,
  keyOf: (...args: A) => string,
  capacity: number,
): (...args: A) => T {
  const cache = new Map<string, { readonly value: T }>();
  return (...args) => {
    const key = keyOf(...args);
    const hit = cache.get(key);
    if (hit !== undefined) return hit.value;
    if (cache.size >= capacity) cache.clear();
    const value = compute(...args);
    cache.set(key, { value });
    return value;
  };
}
