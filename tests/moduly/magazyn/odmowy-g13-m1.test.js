import { afterEach, describe, expect, it } from 'vitest';
import { openOmsDb } from '../../../src/oms/db/db.ts';
import { buildOmsServer } from '../../pomoc/serwer-parytetu.ts';

// PRZ-152.G13 paczka M1: odmowa „panel nie ma podpiętego sklepu" (503) w układzie OMS.
const TEKST = 'Panel nie ma podpiętego żadnego sklepu ani konta Allegro — nie ma skąd czytać katalogu.';
const headers = { authorization: `Basic ${Buffer.from('operator:x').toString('base64')}`, origin: 'http://localhost', 'content-type': 'application/x-www-form-urlencoded' };
let db, server;
afterEach(async () => { await server?.close(); db?.close(); server = db = null; });
const start = () => {
  db = openOmsDb(':memory:');
  server = buildOmsServer({ db, magazyn: { gotowy: () => false, start() {} }, config: { auth: { user: 'operator', pass: 'x' }, sklepy: {}, kanaly: {}, definicje: [] }, poller: { stan: () => ({}) } });
};

const TRASY = [
  '/magazyn/odswiez', '/magazyn/utworz-karty', '/magazyn/podglad-zapisu', '/magazyn/zapisz-do-sklepow',
  '/magazyn/hurt/zatwierdz', '/magazyn/sku-zapisz', '/magazyn/powiazania', '/magazyn/powiazania/odepnij',
  '/magazyn/7', '/magazyn/7/powiaz', '/magazyn/7/odepnij',
];

describe('magazyn bez sklepów — odmowa w układzie OMS', () => {
  for (const url of TRASY) {
    it(`POST ${url}: 503, strona z paskiem i powrotem do magazynu`, async () => {
      start();
      const r = await server.inject({ method: 'POST', url, headers, payload: '' });
      expect(r.statusCode).toBe(503);
      expect(r.headers['content-type']).toMatch(/^text\/html/);
      expect(r.body).toMatch(/<html/);
      expect(r.body).toContain(`<p class="pasek-uwaga" role="alert">${TEKST}</p>`);
      expect(r.body).toContain('<a class="btn" href="/magazyn">Wróć do magazynu</a>');
    });
  }

  it('powrót na zawężoną listę, z której przyszedł człowiek (wroc w treści formularza)', async () => {
    start();
    const r = await server.inject({ method: 'POST', url: '/magazyn/utworz-karty', headers, payload: 'wroc=%2Fmagazyn%3Fq%3Dlampa' });
    expect(r.statusCode).toBe(503);
    expect(r.body).toContain('href="/magazyn?q=lampa"');
  });

  it('obcy adres powrotu wypada na /magazyn', async () => {
    start();
    const r = await server.inject({ method: 'POST', url: '/magazyn/odswiez', headers, payload: 'wroc=%2F%2Fobcy.example.test' });
    expect(r.body).toContain('<a class="btn" href="/magazyn">Wróć do magazynu</a>');
  });
});
