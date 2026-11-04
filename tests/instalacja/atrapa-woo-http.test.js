import { describe, it, expect, afterEach } from 'vitest';
import { createAtrapaWooHttp } from '../../deploy/proba/atrapy/woo-http.mjs';
import { createWooClient } from '../../src/oms/woo/client.js';
import { createServer } from 'node:http';

let serwer;
afterEach(async () => { if (serwer) await new Promise((resolve) => serwer.close(resolve)); serwer = null; });
const auth = 'Basic ' + Buffer.from('ck_test_polcien:cs_test_polcien').toString('base64');
async function start(opcje = {}) {
  serwer = createAtrapaWooHttp(opcje);
  await new Promise((resolve, reject) => { serwer.once('error', reject); serwer.listen(0, '127.0.0.1', resolve); });
  return `http://127.0.0.1:${serwer.address().port}/wp-json/wc/v3`;
}
describe('atrapa HTTP Woo', () => {
  it('wymaga kluczy i udostępnia zamówienia oraz strefy i metody', async () => {
    const url = await start();
    expect((await fetch(`${url}/orders`)).status).toBe(401);
    const get = async (path) => (await fetch(url + path, { headers: { Authorization: auth } })).json();
    expect(await get('/orders?per_page=1')).toHaveLength(1);
    expect(await get('/orders')).toHaveLength(3);
    expect((await get('/shipping/zones')).map((x) => x.id)).toEqual([1, 2, 0]);
    for (const [id, instance] of [[1, 3], [2, 5], [0, 7]]) expect((await get(`/shipping/zones/${id}/methods`))[0].instance_id).toBe(instance);
  });
  it('udostępnia bramki mimo _fields i zamówienia z płatnością oraz wysyłką', async () => {
    const url = await start();
    const get = async (path) => (await fetch(url + path, { headers: { Authorization: auth } })).json();
    const bramki = await get('/payment_gateways?_fields=id');
    expect(bramki.map(({ id, title, enabled }) => ({ id, title, enabled }))).toEqual([
      { id: 'cod', title: 'Płatność przy odbiorze', enabled: true },
      { id: 'bacs', title: 'Przelew bankowy', enabled: true },
      { id: 'polcien_raty', title: 'Raty Półcień', enabled: false },
    ]);
    expect(bramki.every((b) => b.settings.api_key.value === 'sekret_bramki_polcien')).toBe(true);
    const client = createWooClient({ baseUrl: url.replace('/wp-json/wc/v3', ''), ck: 'ck_test_polcien', cs: 'cs_test_polcien' });
    const wynik = await client.pobierzBramkiPlatnosci();
    expect(wynik.map((b) => b.id)).toEqual(['cod', 'bacs', 'polcien_raty']);
    expect(JSON.stringify(wynik)).not.toContain('sekret_bramki_polcien');
    const zamowienia = await get('/orders');
    expect(zamowienia.map((z) => z.payment_method)).toEqual(['cod', 'bacs', '']);
    expect(zamowienia.map((z) => z.shipping_lines[0].instance_id)).toEqual([3, 3, 5]);
    expect(zamowienia.every((z) => typeof z.total === 'string')).toBe(true);
  });
  it('tryb bramki403 odmawia tylko bramek', async () => {
    const url = await start({ tryb: 'bramki403' });
    const get = (path) => fetch(url + path, { headers: { Authorization: auth } });
    expect((await get('/payment_gateways')).status).toBe(403);
    expect((await get('/orders')).status).toBe(200);
  });
  it.each([401, 404, 301])('obsługuje tryb %i', async (tryb) => {
    const url = await start({ tryb, przekierowanie: 'http://127.0.0.1:1234/' });
    const r = await fetch(`${url}/orders`, { headers: { Authorization: auth }, redirect: 'manual' });
    expect(r.status).toBe(tryb);
  });
  it('klient nie przekazuje kluczy do serwera przekierowania na innym porcie', async () => {
    let naglowek;
    const cel = createServer((req, res) => { naglowek = req.headers.authorization; res.writeHead(200); res.end('[]'); });
    await new Promise((resolve, reject) => { cel.once('error', reject); cel.listen(0, '127.0.0.1', resolve); });
    try {
      const url = await start({ tryb: 301, przekierowanie: `http://127.0.0.1:${cel.address().port}/` });
      const client = createWooClient({ baseUrl: url.replace('/wp-json/wc/v3', ''), ck: 'ck_test_polcien', cs: 'cs_test_polcien' });
      expect(await client.sprawdzPolaczenie()).toEqual({ ok: false, powod: 'przekierowanie', status: 200 });
      expect(naglowek).toBeUndefined();
    } finally { await new Promise((resolve) => cel.close(resolve)); }
  });
});
