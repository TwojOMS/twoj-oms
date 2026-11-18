// Transport Allegro Sandbox — host uploadu zdjęć i odczyt operacji z 303.
import { describe, it, expect } from 'vitest';
import { transportAllegroSandbox } from '../../deploy/proba/allegro-sandbox.ts';
import { HOSTY_ALLEGRO } from '../../src/oms/allegro/dcr.ts';
const API = 'https://api.allegro.pl.allegrosandbox.pl',
  UPLOAD = 'https://upload.allegro.pl.allegrosandbox.pl';
/** Atrapa fetch: przekierowanie przy innym trybie niż 'manual' kończy się błędem, jak w prawdziwym fetch. */
function transport() {
  const tryby: unknown[] = [];
  const http = transportAllegroSandbox({
    tryb: 'proba',
    fetchImpl: async (_u, i) => {
      tryby.push(i?.redirect);
      if (i?.redirect !== 'manual') throw new TypeError('fetch failed: redirect');
      return new Response(null, { status: 303, headers: { Location: API + '/sale/product-offers/7700001' } });
    },
  });
  const wynik = (adres: string, init?: RequestInit) =>
    http(adres, init).then(
      (r) => 'HTTP ' + r.status,
      (e: Error) => 'błąd: ' + e.message,
    );
  return { tryby, wynik };
}
describe('transport Allegro Sandbox', () => {
  it('odczyt operacji oferty z 303 oddaje odpowiedź', async () => {
    const t = transport();
    expect(await t.wynik(API + '/sale/product-offers/7700001/operations/op-1', { redirect: 'manual' })).toBe(
      'HTTP 303',
    );
    expect(t.tryby).toEqual(['manual']);
  });
  it.each([
    ['GET', API + '/sale/product-offers/7700001'],
    ['GET', API + '/order/checkout-forms/1'],
    ['POST', API + '/sale/product-offers/7700001/operations/op-1'],
  ])('%s %s z przekierowaniem odmawia, nawet gdy wywołujący prosi o manual', async (method, adres) => {
    const t = transport();
    expect(await t.wynik(adres, { method, redirect: 'manual' })).toMatch(/^błąd: /);
    expect(t.tryby).toEqual(['error']);
  });
  it('odczyt operacji nie podąża za przekierowaniem (follow → error)', async () => {
    const t = transport();
    expect(await t.wynik(API + '/sale/product-offers/7700001/operations/op-1', { redirect: 'follow' })).toMatch(
      /^błąd: /,
    );
    expect(t.tryby).toEqual(['error']);
  });
  it('host uploadu przyjmuje tylko /sale/images', async () => {
    const wywolania: string[] = [];
    const http = transportAllegroSandbox({
      tryb: 'proba',
      fetchImpl: async (u) => {
        wywolania.push(String(u));
        return Response.json({ location: 'https://a.allegroimg.example/z' });
      },
    });
    const r = await http(UPLOAD + '/sale/images', { method: 'POST', body: new Uint8Array([1, 2, 3]) }).then(
      (r) => 'HTTP ' + r.status,
      (e: Error) => 'błąd: ' + e.message,
    );
    expect(r).toBe('HTTP 200');
    for (const adres of [
      UPLOAD + '/inna-sciezka',
      UPLOAD + '/sale/images/1',
      UPLOAD + '/sale/product-offers',
      'https://upload.allegro.pl/sale/images',
    ]) {
      expect(
        await http(adres, { method: 'POST' }).then(
          () => 'przepuszczony',
          (e: Error) => e.message,
        ),
      ).toMatch(/nie jest dozwolonym zasobem/);
    }
    expect(wywolania).toEqual([UPLOAD + '/sale/images']);
  });
  it('HOSTY_ALLEGRO znają host uploadu w obu środowiskach', () => {
    expect(HOSTY_ALLEGRO.produkcja.upload).toBe('https://upload.allegro.pl');
    expect(HOSTY_ALLEGRO.sandbox.upload).toBe(UPLOAD);
  });
});
