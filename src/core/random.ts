/**
 * A small seeded PRNG (mulberry32), so a randomized workload or chaos soak can
 * be replayed exactly: the same seed gives the same URLs, delays and faults.
 */
export class Rng {
  #s: number;
  readonly seed: number;

  constructor(seed: number = Date.now() >>> 0) {
    this.seed = seed >>> 0;
    this.#s = this.seed;
  }

  /** In [0, 1). */
  next(): number {
    let t = (this.#s = (this.#s + 0x6d2b79f5) >>> 0);
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  }

  /** An integer in [min, max]. */
  int(min: number, max: number): number {
    return min + Math.floor(this.next() * (max - min + 1));
  }

  pick<T>(items: readonly T[]): T {
    if (items.length === 0) throw new Error('cannot pick from an empty list');
    return items[Math.floor(this.next() * items.length)];
  }

  chance(p: number): boolean {
    return this.next() < p;
  }
}
