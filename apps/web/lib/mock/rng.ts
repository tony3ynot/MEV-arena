/**
 * Seeded randomness for the mock. Integer operations only, so every JS engine produces the same numbers.
 * Not for cryptography.
 */

/** mulberry32: a tiny 32-bit PRNG. Same seed, same sequence. */
export class Rng {
  private state: number;

  constructor(seed: number) {
    this.state = seed >>> 0;
  }

  nextUint32(): number {
    this.state = (this.state + 0x6d2b79f5) >>> 0;
    let t = this.state;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return (t ^ (t >>> 14)) >>> 0;
  }

  /** A float in [0, 1). */
  next(): number {
    return this.nextUint32() / 4294967296;
  }

  /** An integer in [lo, hi], both ends included. */
  int(lo: number, hi: number): number {
    return lo + Math.floor(this.next() * (hi - lo + 1));
  }

  chance(probability: number): boolean {
    return this.next() < probability;
  }

  /** Fisher-Yates shuffle into a new array. */
  shuffle<T>(items: readonly T[]): T[] {
    const out = [...items];
    for (let i = out.length - 1; i > 0; i--) {
      const j = this.int(0, i);
      [out[i], out[j]] = [out[j], out[i]];
    }
    return out;
  }
}

/** FNV-1a 32-bit hash of a string. */
export function fnv1a(text: string, offset = 0x811c9dc5): number {
  let h = offset >>> 0;
  for (let i = 0; i < text.length; i++) {
    h ^= text.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  return h >>> 0;
}

/**
 * A new generator for one purpose, derived from the simulation seed and labels such as
 * ("noise", height, accountId). Each bot, block and purpose draws from its own stream, so one more draw in
 * one place never shifts the numbers anywhere else.
 */
export function rngFor(seed: number, ...labels: (string | number)[]): Rng {
  return new Rng(fnv1a([seed, ...labels].join("|")));
}

/**
 * 64 hex characters derived from `text`. The mock's stand-in for the engine's sha256 state root:
 * deterministic, but NOT sha256, so it never matches a root computed by the Python engine.
 */
export function mockHash(text: string): string {
  let out = "";
  for (let k = 0; k < 8; k++) out += fnv1a(`${k}|${text}`).toString(16).padStart(8, "0");
  return out;
}
