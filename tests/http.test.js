import { describe, it, expect, vi, beforeEach } from 'vitest';

describe('politeFetch', () => {
  beforeEach(() => {
    vi.resetModules();
  });

  it('rate-limits requests to the same host to >=1s apart', async () => {
    const fetches = [];
    const fakeFetch = vi.fn(async (url) => {
      fetches.push({ url, at: Date.now() });
      return { status: 200, ok: true, text: async () => 'ok' };
    });
    const { politeFetch } = await import('../src/http.js');
    politeFetch.__setFetch(fakeFetch);

    const t0 = Date.now();
    await politeFetch('https://example.com/a');
    await politeFetch('https://example.com/b');
    const elapsed = Date.now() - t0;

    expect(fetches).toHaveLength(2);
    expect(elapsed).toBeGreaterThanOrEqual(950);
  });

  it('does not rate-limit across different hosts', async () => {
    const fakeFetch = vi.fn(async () => ({ status: 200, ok: true, text: async () => 'ok' }));
    const { politeFetch } = await import('../src/http.js');
    politeFetch.__setFetch(fakeFetch);

    const t0 = Date.now();
    await politeFetch('https://a.example.com/x');
    await politeFetch('https://b.example.com/x');
    const elapsed = Date.now() - t0;

    expect(elapsed).toBeLessThan(500);
  });

  it('retries on 429 with backoff and eventually succeeds', async () => {
    let calls = 0;
    const fakeFetch = vi.fn(async () => {
      calls++;
      if (calls < 2) return { status: 429, ok: false, text: async () => '' };
      return { status: 200, ok: true, text: async () => 'ok' };
    });
    const { politeFetch } = await import('../src/http.js');
    politeFetch.__setFetch(fakeFetch);
    politeFetch.__setBackoffBase(10);

    const res = await politeFetch('https://retry.example.com/x');
    expect(res.status).toBe(200);
    expect(calls).toBe(2);
  });

  it('sets a contact User-Agent', async () => {
    let seenHeaders;
    const fakeFetch = vi.fn(async (url, opts) => {
      seenHeaders = opts.headers;
      return { status: 200, ok: true, text: async () => 'ok' };
    });
    const { politeFetch } = await import('../src/http.js');
    politeFetch.__setFetch(fakeFetch);

    await politeFetch('https://ua.example.com/x');
    expect(seenHeaders['User-Agent']).toMatch(/mediagraf-municipal-contracts-bot/);
    expect(seenHeaders['User-Agent']).toMatch(/gustaf@binogi.com/);
  });
});
