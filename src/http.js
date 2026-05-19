import { fetch as undiciFetch } from 'undici';

const HOST_RATE_MS = 1000;
const MAX_RETRIES = 3;
let backoffBase = 1000;
let fetchImpl = undiciFetch;
const lastRequestAt = new Map();
const inflight = new Map();

async function waitForHostSlot(host) {
  const prev = inflight.get(host) ?? Promise.resolve();
  let release;
  const next = new Promise((r) => (release = r));
  inflight.set(host, prev.then(() => next));
  await prev;
  const last = lastRequestAt.get(host) ?? 0;
  const wait = Math.max(0, last + HOST_RATE_MS - Date.now());
  if (wait > 0) await new Promise((r) => setTimeout(r, wait));
  lastRequestAt.set(host, Date.now());
  return release;
}

export async function politeFetch(url, options = {}) {
  const u = new URL(url);
  const release = await waitForHostSlot(u.host);
  try {
    const headers = {
      'User-Agent':
        'mediagraf-municipal-contracts-bot/1.0 (+mailto:gustaf@binogi.com)',
      Accept: 'text/html,application/xhtml+xml,*/*;q=0.8',
      'Accept-Language': 'sv,en;q=0.8',
      ...(options.headers ?? {}),
    };

    let lastErr;
    let lastStatus;
    for (let attempt = 0; attempt < MAX_RETRIES; attempt++) {
      try {
        const res = await fetchImpl(url, { ...options, headers });
        if (res.status === 429 || res.status === 503) {
          lastStatus = res.status;
          const backoff = backoffBase * Math.pow(2, attempt);
          await new Promise((r) => setTimeout(r, backoff));
          continue;
        }
        return res;
      } catch (e) {
        lastErr = e;
        const backoff = backoffBase * Math.pow(2, attempt);
        await new Promise((r) => setTimeout(r, backoff));
      }
    }
    if (lastErr) throw lastErr;
    if (lastStatus) throw new Error(`Failed after ${MAX_RETRIES} attempts: ${url} (last status ${lastStatus})`);
    throw new Error(`Failed after ${MAX_RETRIES} attempts: ${url}`);
  } finally {
    release();
  }
}

politeFetch.__setFetch = (f) => {
  fetchImpl = f;
};
politeFetch.__setBackoffBase = (ms) => {
  backoffBase = ms;
};
