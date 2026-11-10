/**
 * Short-lived, bounded cache for profile picture lookups.
 *
 * Why: `messages.upsert`, `contacts.upsert` and `contacts.update` look up the
 * sender's profile picture inside the instance's single event queue. With
 * Baileys 7.0.0-rc13+ some of those lookups never get an answer and wait the
 * full 60s query timeout, so every message from such a contact froze the whole
 * queue (no `messages.upsert` webhook for anyone meanwhile). Caching the result
 * per JID, failures included, keeps a slow or broken lookup from being repeated
 * for every message; the caller also bounds each lookup with a timeout.
 */

export type ProfilePictureUrl = string | null | undefined;

export type ProfilePictureFetcher = (jid: string) => Promise<ProfilePictureUrl>;

export interface ProfilePictureCacheOptions {
  /** How long a successful result (URL or "no picture") is reused, in ms. */
  ttlMs: number;
  /**
   * How long a failed lookup (timeout, connection closed) is reused, in ms.
   * Shorter than `ttlMs` so a transient failure, e.g. during a reconnect, does
   * not blank the picture for long. Defaults to `ttlMs`.
   */
  failureTtlMs?: number;
  /** Upper bound on cached JIDs; the oldest entries are evicted first. */
  maxEntries: number;
  /** Clock, injectable for tests. */
  now?: () => number;
}

interface Entry {
  /** `undefined` = no picture (as Baileys returns it), `null` = lookup failed. */
  url: ProfilePictureUrl;
  expiresAt: number;
}

export class ProfilePictureCache {
  private readonly entries = new Map<string, Entry>();
  private readonly inFlight = new Map<string, Promise<ProfilePictureUrl>>();
  /** Latest lookup started per JID: an older lookup that ends later must not overwrite it. */
  private readonly latestLookup = new Map<string, number>();
  private lookupSeq = 0;
  private readonly now: () => number;

  constructor(private readonly options: ProfilePictureCacheOptions) {
    this.now = options.now ?? Date.now;
  }

  get size() {
    return this.entries.size;
  }

  /**
   * Returns the cached URL for `jid`, or runs `fetcher` once (concurrent callers
   * for the same JID share the same lookup) and caches what it returns. A thrown
   * error is cached as `null` (what the old uncached code returned on error) for
   * `failureTtlMs`, so a contact whose lookup fails is not retried on every
   * message. With `refresh`, a new lookup always runs and its result wins over
   * any older lookup still in flight.
   */
  async get(
    jid: string,
    fetcher: ProfilePictureFetcher,
    options: { refresh?: boolean } = {},
  ): Promise<ProfilePictureUrl> {
    if (!options.refresh) {
      const cached = this.entries.get(jid);
      if (cached) {
        if (cached.expiresAt > this.now()) {
          return cached.url;
        }
        this.entries.delete(jid);
      }

      const pending = this.inFlight.get(jid);
      if (pending) {
        return pending;
      }
    }

    const seq = ++this.lookupSeq;
    this.latestLookup.set(jid, seq);

    const lookup = (async () => {
      let url: ProfilePictureUrl = null;
      let failed = false;
      try {
        url = await fetcher(jid);
      } catch {
        url = null;
        failed = true;
      }
      if (this.latestLookup.get(jid) === seq) {
        this.latestLookup.delete(jid);
        this.set(jid, url, failed ? this.options.failureTtlMs : undefined);
      }
      return url;
    })();

    this.inFlight.set(jid, lookup);
    try {
      return await lookup;
    } finally {
      if (this.inFlight.get(jid) === lookup) {
        this.inFlight.delete(jid);
      }
    }
  }

  set(jid: string, url: ProfilePictureUrl, ttlMs: number = this.options.ttlMs) {
    if (ttlMs <= 0 || this.options.maxEntries <= 0) {
      this.entries.delete(jid);
      return;
    }
    // Re-insert so the Map's insertion order reflects recency.
    this.entries.delete(jid);
    this.entries.set(jid, { url, expiresAt: this.now() + ttlMs });
    while (this.entries.size > this.options.maxEntries) {
      const oldest = this.entries.keys().next().value;
      this.entries.delete(oldest);
    }
  }

  delete(jid: string) {
    this.entries.delete(jid);
  }

  clear() {
    this.entries.clear();
    this.inFlight.clear();
    this.latestLookup.clear();
  }
}

/** Reads a non-negative integer from an env var, falling back to `fallback`. */
export function nonNegativeIntFromEnv(value: string | undefined, fallback: number): number {
  if (value === undefined || value.trim() === '') {
    return fallback;
  }
  const parsed = Number(value);
  return Number.isFinite(parsed) && parsed >= 0 ? Math.floor(parsed) : fallback;
}

/** Reads a positive integer from an env var; missing, invalid or 0 gives `fallback`. */
export function positiveIntFromEnv(value: string | undefined, fallback: number): number {
  return nonNegativeIntFromEnv(value, fallback) || fallback;
}
