// In-process token-bucket rate limiter for the brackish daemon's TCP attack surface.
//
// Three integration points (see server.ts): /connect (invite redemption) keyed by IP,
// failed bearer-auth lookups keyed by IP, and POST /ui-sessions keyed by identity.
// Socket-transport callers bypass — peer-trust + filesystem perms already gate access.
//
// The limiter is deliberately simple: a Map<key, bucket> with periodic sweep. No Redis,
// no external state — the brackish daemon is a single-process node service, and adding
// a network dependency for this volume of traffic is unjustified weight.

export type LimiterConfig = {
  /** Max requests allowed in any rolling window of `windowSeconds`. */
  burst: number;
  /** Length of the rolling window in seconds. */
  windowSeconds: number;
};

type Bucket = {
  /** Timestamps (ms) of recent admitted requests, sorted oldest-first. */
  hits: number[];
};

export class RateLimiter {
  private readonly buckets = new Map<string, Bucket>();
  private readonly burst: number;
  private readonly windowMs: number;
  private readonly sweepTimer: ReturnType<typeof setInterval>;

  constructor(cfg: LimiterConfig) {
    this.burst = cfg.burst;
    this.windowMs = cfg.windowSeconds * 1000;
    // Sweep expired buckets every minute. unref() so the timer doesn't keep the
    // event loop alive in tests that close the server.
    this.sweepTimer = setInterval(() => this.sweep(), 60_000);
    this.sweepTimer.unref();
  }

  /** Returns true and admits the request, or returns false (denied) when the bucket is full. */
  tryConsume(key: string): boolean {
    const bucket = this.bucketFor(key);
    if (bucket.hits.length >= this.burst) return false;
    bucket.hits.push(Date.now());
    return true;
  }

  /** True if a subsequent tryConsume would deny — i.e. the bucket already holds
   *  `burst` hits within the rolling window. Useful when callers want to decide
   *  whether to attempt an operation at all (e.g. throttle FAILED auths without
   *  consuming a slot on every request). */
  isExhausted(key: string): boolean {
    const bucket = this.bucketFor(key);
    return bucket.hits.length >= this.burst;
  }

  /** How many seconds until the oldest hit in a full bucket drops out. */
  retryAfterSeconds(key: string): number {
    const bucket = this.buckets.get(key);
    if (!bucket || bucket.hits.length === 0) return 0;
    const oldest = bucket.hits[0] ?? Date.now();
    const wait = Math.ceil((oldest + this.windowMs - Date.now()) / 1000);
    return Math.max(1, wait);
  }

  /** Fetch (or create) a bucket and evict expired hits. Shared by tryConsume/isExhausted. */
  private bucketFor(key: string): Bucket {
    const cutoff = Date.now() - this.windowMs;
    let bucket = this.buckets.get(key);
    if (!bucket) {
      bucket = { hits: [] };
      this.buckets.set(key, bucket);
    }
    while (bucket.hits.length > 0 && (bucket.hits[0] ?? 0) < cutoff) bucket.hits.shift();
    return bucket;
  }

  /** Drop empty / fully-aged buckets. Called periodically by the sweep timer. */
  private sweep(): void {
    const cutoff = Date.now() - this.windowMs;
    for (const [key, bucket] of this.buckets) {
      while (bucket.hits.length > 0 && (bucket.hits[0] ?? 0) < cutoff) bucket.hits.shift();
      if (bucket.hits.length === 0) this.buckets.delete(key);
    }
  }

  /** Stop the sweep timer. Tests should call this on teardown to fully release the limiter. */
  close(): void {
    clearInterval(this.sweepTimer);
  }
}
