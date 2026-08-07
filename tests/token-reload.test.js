// A fresh sign-in rewrites the Gmail token file. Long-running processes must
// pick it up without a restart — otherwise "Återanslut Gmail" fixes the file
// and the daemon keeps failing on the dead credential, which is exactly what
// happened on 2026-08-07.
import { describe, it, expect } from 'vitest';
import { makeReloadingClient } from '../src/gmail.js';

describe('makeReloadingClient', () => {
  function harness({ start = 1000 } = {}) {
    const state = { mtime: start, builds: 0 };
    const current = makeReloadingClient({
      tokenPath: '/nope/token.json',
      build: () => ({ id: ++state.builds }),
      statImpl: () => {
        if (state.mtime === null) throw new Error('ENOENT');
        return { mtimeMs: state.mtime };
      },
    });
    return { state, current };
  }

  it('builds once and reuses the client while the file is unchanged', () => {
    const { current, state } = harness();
    expect(current()).toEqual({ id: 1 });
    expect(current()).toEqual({ id: 1 });
    expect(state.builds).toBe(1);
  });

  it('rebuilds after a re-auth rewrites the token', () => {
    const { current, state } = harness();
    expect(current().id).toBe(1);
    state.mtime = 2000;              // sign-in wrote a new token
    expect(current().id).toBe(2);
    expect(current().id).toBe(2);    // and settles again
  });

  it('reports no client while the token file is missing, then picks it up', () => {
    const { current, state } = harness({ start: null });
    expect(current()).toBeNull();
    expect(state.builds).toBe(0);    // never built from a missing file
    state.mtime = 500;               // first ever pilot-auth
    expect(current()).toEqual({ id: 1 });
  });

  it('goes back to null if the token file disappears', () => {
    const { current, state } = harness();
    expect(current()).not.toBeNull();
    state.mtime = null;
    expect(current()).toBeNull();
  });
});
