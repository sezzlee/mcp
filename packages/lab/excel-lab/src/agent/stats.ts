/** Two-sided exact McNemar p-value for b pairs only the treatment got right and c only the control got right. */
export function mcnemarExact(b: number, c: number): number {
  const n = b + c;
  if (n === 0) return 1;
  const k = Math.min(b, c);
  let tail = 0;
  let term = 0.5 ** n;
  for (let i = 0; i <= k; i += 1) {
    tail += term;
    term = (term * (n - i)) / (i + 1);
  }
  return Math.min(1, 2 * tail);
}

function mulberry32(seed: number): () => number {
  let state = seed >>> 0;
  return () => {
    state = (state + 0x6d2b79f5) >>> 0;
    let t = state;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/**
 * A percentile interval for the mean of per-pair differences, resampling
 * whole clusters (file families) with replacement, because a file's tasks,
 * translations and variants are not independent. Seeded, so a report is
 * reproducible.
 */
export function clusterBootstrap(input: {
  readonly clusters: readonly (readonly number[])[];
  readonly resamples: number;
  readonly seed: number;
  readonly level: number;
}): { readonly low: number; readonly high: number } | null {
  const clusters = input.clusters.filter((cluster) => cluster.length > 0);
  if (clusters.length < 2) return null;
  const random = mulberry32(input.seed);
  const means: number[] = [];
  for (let round = 0; round < input.resamples; round += 1) {
    let sum = 0;
    let count = 0;
    for (let draw = 0; draw < clusters.length; draw += 1) {
      const cluster = clusters[Math.floor(random() * clusters.length)] ?? [];
      for (const value of cluster) sum += value;
      count += cluster.length;
    }
    means.push(sum / count);
  }
  means.sort((left, right) => left - right);
  const tail = (1 - input.level) / 2;
  const at = (fraction: number): number =>
    means[Math.min(means.length - 1, Math.floor(fraction * means.length))] ??
    Number.NaN;
  return { low: at(tail), high: at(1 - tail) };
}
