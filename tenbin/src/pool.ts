/**
 * Runs fn over items with at most `limit` in flight. Scheduling stops once `signal` aborts or any
 * call throws; the first error is rethrown after the in-flight calls have settled. Slots for items
 * that never ran are left empty.
 */
export async function pool<T, R>(items: T[], limit: number, fn: (item: T) => Promise<R>, signal?: AbortSignal): Promise<R[]> {
  const out: R[] = new Array(items.length);
  let next = 0;
  let failure: { error: unknown } | undefined;
  const workers = Array.from({ length: Math.min(limit, items.length) }, async () => {
    while (next < items.length && !signal?.aborted && !failure) {
      const i = next++;
      try {
        out[i] = await fn(items[i]);
      } catch (error) {
        failure ??= { error };
      }
    }
  });
  await Promise.all(workers);
  if (failure) throw failure.error;
  return out;
}
