import { expect, it } from 'vitest';
import { openOmsDb } from '../../../src/oms/db/db.ts';
import { buildOmsServer } from '../../pomoc/serwer-parytetu.ts';

it('Historia podjazdów używa przycisku drugiego rzędu w obu motywach', async () => {
  const db = openOmsDb(':memory:');
  const app = buildOmsServer({ db, config: { auth: { user: 'operator', pass: 'x' }, klienciZbiorczy: [] } });
  try {
    for (const motyw of ['jasny', 'ciemny']) {
      const r = await app.inject({ url: '/przesylki', headers: {
        authorization: `Basic ${Buffer.from('operator:x').toString('base64')}`, cookie: `oms_motyw=${motyw}`,
      } });
      expect(r.statusCode).toBe(200);
      expect(r.body).toContain('<a class="btn btn--drugi" href="/przesylki/podjazdy/historia">Historia podjazdów</a>');
    }
  } finally { await app.close(); db.close(); }
});
