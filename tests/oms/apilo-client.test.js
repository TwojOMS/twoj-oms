import { describe, it, expect, vi } from 'vitest';
import { createApiloClient } from '../../src/oms/apilo/client.js';

function creds(overrides = {}) {
  return {
    host: 'https://szkicownia.apilo.com', clientId: '3', clientSecret: 'sec',
    accessToken: 'AAA', accessTokenExpireAt: '2999-01-01T00:00:00+0000',
    refreshToken: 'RRR', refreshTokenExpireAt: '2999-01-01T00:00:00+0000',
    ...overrides,
  };
}

function makeClient(credState, fetchImpl) {
  let state = credState;
  return createApiloClient({
    host: 'https://szkicownia.apilo.com', credentialsPath: '/x.json', fetchImpl,
    readFile: () => JSON.stringify(state),
    writeFile: (p, data) => { state = JSON.parse(data); },
    now: () => Date.parse('2026-07-13T00:00:00Z'),
  });
}

describe('apilo client', () => {
  it('sends bearer auth and parses JSON', async () => {
    const fetchImpl = vi.fn().mockResolvedValue(new Response(JSON.stringify({ ok: 1 }), { status: 200 }));
    const client = makeClient(creds(), fetchImpl);
    const res = await client.request('GET', '/rest/api/orders/?limit=1');
    expect(res).toEqual({ ok: 1 });
    const [url, opts] = fetchImpl.mock.calls[0];
    expect(url).toBe('https://szkicownia.apilo.com/rest/api/orders/?limit=1');
    expect(opts.headers.Authorization).toBe('bearer AAA');
  });
  it('throws with status on >=400', async () => {
    const fetchImpl = vi.fn().mockResolvedValue(new Response(JSON.stringify({ message: 'Not found' }), { status: 404 }));
    const client = makeClient(creds(), fetchImpl);
    await expect(client.request('GET', '/rest/api/orders/NOPE/')).rejects.toMatchObject({ status: 404 });
  });
  it('refreshes an (almost) expired token before the call', async () => {
    const fetchImpl = vi.fn()
      .mockResolvedValueOnce(new Response(JSON.stringify({
        accessToken: 'NEW', accessTokenExpireAt: '2999-01-01T00:00:00+0000',
        refreshToken: 'NEWR', refreshTokenExpireAt: '2999-01-01T00:00:00+0000',
      }), { status: 200 }))
      .mockResolvedValueOnce(new Response(JSON.stringify({ ok: 1 }), { status: 200 }));
    const client = makeClient(creds({ accessTokenExpireAt: '2026-07-13T00:00:30Z' }), fetchImpl);
    await client.request('GET', '/rest/api/orders/');
    expect(fetchImpl.mock.calls[0][0]).toBe('https://szkicownia.apilo.com/rest/auth/token/');
    expect(fetchImpl.mock.calls[1][1].headers.Authorization).toBe('bearer NEW');
  });
  it('returns .status on non-JSON error body (e.g. HTML 502)', async () => {
    const fetchImpl = vi.fn().mockResolvedValue(new Response('<html>502 Bad Gateway</html>', { status: 502 }));
    const client = makeClient(creds(), fetchImpl);
    await expect(client.request('GET', '/rest/api/orders/')).rejects.toMatchObject({ status: 502 });
  });
});
