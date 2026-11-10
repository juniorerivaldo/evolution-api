import assert from 'node:assert/strict';
import { describe, test } from 'node:test';

import { nonNegativeIntFromEnv, positiveIntFromEnv, ProfilePictureCache } from '../src/utils/profilePictureCache';

function clock(start = 1_000_000) {
  let now = start;
  return { now: () => now, advance: (ms: number) => (now += ms) };
}

describe('ProfilePictureCache', () => {
  test('reuses a result per JID until it expires', async () => {
    const time = clock();
    const cache = new ProfilePictureCache({ ttlMs: 10_000, maxEntries: 10, now: time.now });
    let calls = 0;
    const fetcher = async () => {
      calls++;
      return `https://pps.example/${calls}.jpg`;
    };

    assert.equal(await cache.get('a@s.whatsapp.net', fetcher), 'https://pps.example/1.jpg');
    assert.equal(await cache.get('a@s.whatsapp.net', fetcher), 'https://pps.example/1.jpg');
    assert.equal(calls, 1);

    time.advance(10_001);
    assert.equal(await cache.get('a@s.whatsapp.net', fetcher), 'https://pps.example/2.jpg');
    assert.equal(calls, 2);
  });

  test('caches failures as null so a broken lookup is not retried per message', async () => {
    const cache = new ProfilePictureCache({ ttlMs: 10_000, maxEntries: 10 });
    let calls = 0;
    const failing = async () => {
      calls++;
      throw new Error('Timed Out');
    };

    assert.equal(await cache.get('b@lid', failing), null);
    assert.equal(await cache.get('b@lid', failing), null);
    assert.equal(calls, 1);
  });

  test('keeps "no picture" (undefined) apart from "lookup failed" (null)', async () => {
    const cache = new ProfilePictureCache({ ttlMs: 10_000, maxEntries: 10 });
    let calls = 0;
    const noPicture = async () => {
      calls++;
      return undefined;
    };

    assert.equal(await cache.get('c@s.whatsapp.net', noPicture), undefined);
    assert.equal(await cache.get('c@s.whatsapp.net', noPicture), undefined);
    assert.equal(calls, 1, 'a contact without a picture is cached too');
  });

  test('concurrent lookups for the same JID share one request', async () => {
    const cache = new ProfilePictureCache({ ttlMs: 10_000, maxEntries: 10 });
    let calls = 0;
    let release: (url: string) => void;
    const slow = () =>
      new Promise<string>((resolve) => {
        calls++;
        release = resolve;
      });

    const first = cache.get('d@s.whatsapp.net', slow);
    const second = cache.get('d@s.whatsapp.net', slow);
    release('https://pps.example/d.jpg');

    assert.deepEqual(await Promise.all([first, second]), ['https://pps.example/d.jpg', 'https://pps.example/d.jpg']);
    assert.equal(calls, 1);
  });

  test('refresh bypasses the cached value and stores the new one', async () => {
    const cache = new ProfilePictureCache({ ttlMs: 10_000, maxEntries: 10 });
    let version = 0;
    const fetcher = async () => `https://pps.example/v${++version}.jpg`;

    assert.equal(await cache.get('e@s.whatsapp.net', fetcher), 'https://pps.example/v1.jpg');
    assert.equal(await cache.get('e@s.whatsapp.net', fetcher, { refresh: true }), 'https://pps.example/v2.jpg');
    assert.equal(await cache.get('e@s.whatsapp.net', fetcher), 'https://pps.example/v2.jpg');
  });

  test('evicts the oldest entries beyond maxEntries', async () => {
    const cache = new ProfilePictureCache({ ttlMs: 10_000, maxEntries: 2 });
    let calls = 0;
    const fetcher = async (jid: string) => {
      calls++;
      return jid;
    };

    await cache.get('1', fetcher);
    await cache.get('2', fetcher);
    await cache.get('3', fetcher);
    assert.equal(cache.size, 2);

    await cache.get('1', fetcher);
    assert.equal(calls, 4, 'the oldest entry was evicted and fetched again');
  });

  test('failures expire after failureTtlMs, successes after ttlMs', async () => {
    const time = clock();
    const cache = new ProfilePictureCache({ ttlMs: 600_000, failureTtlMs: 60_000, maxEntries: 10, now: time.now });
    let calls = 0;
    const flaky = async () => {
      calls++;
      if (calls === 1) throw new Error('Connection Closed');
      return 'https://pps.example/ok.jpg';
    };

    assert.equal(await cache.get('g', flaky), null);
    time.advance(30_000);
    assert.equal(await cache.get('g', flaky), null, 'failure still cached');
    time.advance(30_001);
    assert.equal(await cache.get('g', flaky), 'https://pps.example/ok.jpg', 'retried after failureTtlMs');
    assert.equal(calls, 2);
  });

  test('an older lookup that ends after a refresh does not overwrite it', async () => {
    const cache = new ProfilePictureCache({ ttlMs: 600_000, maxEntries: 10 });
    let releaseOld: (url: string) => void;
    const slowOld = () => new Promise<string>((resolve) => (releaseOld = resolve));
    const fastNew = async () => 'https://pps.example/new.jpg';

    const old = cache.get('h', slowOld);
    assert.equal(await cache.get('h', fastNew, { refresh: true }), 'https://pps.example/new.jpg');
    releaseOld('https://pps.example/old.jpg');
    assert.equal(await old, 'https://pps.example/old.jpg');
    assert.equal(await cache.get('h', async () => 'unexpected'), 'https://pps.example/new.jpg');
  });

  test('ttlMs = 0 disables caching', async () => {
    const cache = new ProfilePictureCache({ ttlMs: 0, maxEntries: 10 });
    let calls = 0;
    const fetcher = async () => `url-${++calls}`;

    await cache.get('f', fetcher);
    await cache.get('f', fetcher);
    assert.equal(calls, 2);
    assert.equal(cache.size, 0);
  });
});

describe('nonNegativeIntFromEnv', () => {
  test('parses valid values and falls back on missing or invalid ones', () => {
    assert.equal(nonNegativeIntFromEnv(undefined, 5000), 5000);
    assert.equal(nonNegativeIntFromEnv('', 5000), 5000);
    assert.equal(nonNegativeIntFromEnv('  ', 5000), 5000);
    assert.equal(nonNegativeIntFromEnv('abc', 5000), 5000);
    assert.equal(nonNegativeIntFromEnv('-1', 5000), 5000);
    assert.equal(nonNegativeIntFromEnv('2500', 5000), 2500);
    assert.equal(nonNegativeIntFromEnv('2500.9', 5000), 2500);
    assert.equal(nonNegativeIntFromEnv('0', 5000), 0);
  });

  test('positiveIntFromEnv treats 0 as missing', () => {
    assert.equal(positiveIntFromEnv('0', 5000), 5000);
    assert.equal(positiveIntFromEnv('1500', 5000), 1500);
    assert.equal(positiveIntFromEnv(undefined, 5000), 5000);
  });
});
