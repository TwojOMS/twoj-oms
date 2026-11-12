import { describe, it, expect } from 'vitest';
import { openOmsDb } from '../../../src/oms/db/db.ts';
import { zapiszKonfiguracjeIntegracji } from '../../../src/oms/db/konfiguracja-integracji.js';
import { createFabrykaErli, uwagaToruErli } from '../../../src/moduly/kanaly/services/kanal-erli.ts';

// PRZ-157.04 — fabryka kanału ERLI dla rejestru kanałów: konfiguracja `erli:<klucz>`, tor w diagnostyce.
const TERAZ = new Date('2026-11-13T12:00:00Z');
const KLUCZ_TESTOWY = 'klucz-testowy-nie-do-logu';
const polaczenie = { klucz: 'erli_pc', odUtc: null };

const zam = {
  id: 'PC-ERLI-0001', status: 'purchased', currency: 'PLN', market: 'pl', totalPrice: 1000,
  created: '2026-11-13T09:00:00Z', updated: '2026-11-13T09:05:00Z', purchasedAt: '2026-11-13T09:01:00Z',
  user: { email: 'ala@polcien.example', deliveryAddress: { firstName: 'Ala', lastName: 'Zmyślonowicz', street: 'Fikcyjna', buildingNumber: '1', city: 'Testowo', country: 'pl', zip: '00-000', phone: '000000000' } },
  delivery: { name: 'Kurier testowy', typeId: 'kurierTestowy', price: 0, cod: false },
  items: [{ id: 1, externalId: 'PC-OF-001', quantity: 1, unitPrice: 1000, name: 'Szablon', slug: 'szablon', taxRate: 'TAX_23', dispatchTime: { period: 1, unit: 'day' } }],
};

const json = (status, body) => new Response(body === undefined ? null : JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });

function atrapaHttp({ zmiany404 = false } = {}) {
  const wywolania = [];
  const http = async (url, init = {}) => {
    const sciezka = new URL(url).pathname;
    wywolania.push({ sciezka, autoryzacja: new Headers(init.headers).get('Authorization') });
    if (sciezka.endsWith('/orders/changes/_search')) return zmiany404 ? json(404, { message: 'nie ma' }) : json(200, [{ id: 'm1', shopId: 1000001, created: '2026-11-13T09:06:00Z', read: false, type: 'orderCreated', payload: zam }]);
    if (sciezka.endsWith('/inbox/_search')) return json(200, []);
    if (sciezka.endsWith('/orders/_search')) return json(200, []);
    if (sciezka.endsWith('mark-read')) return json(200, { count: 1 });
    return json(404, {});
  };
  return { http, wywolania };
}

function bazaZKluczem(ustawienia = {}) {
  const db = openOmsDb(':memory:');
  zapiszKonfiguracjeIntegracji(db, 'erli:erli_pc', { ustawienia, sekrety: { kluczApi: KLUCZ_TESTOWY } });
  return db;
}

describe('fabryka kanału ERLI', () => {
  it('brak zapisanego klucza API → czytelny błąd bez sekretów', () => {
    const db = openOmsDb(':memory:');
    const { http } = atrapaHttp();
    const fabryka = createFabrykaErli({ db, teraz: () => TERAZ });
    expect(() => fabryka({ polaczenie, http, httpAutoryzacji: http, sprawdzZapis: () => {} })).toThrow(/ERLI.*klucza API/);
  });

  it('z kluczem: przebieg importuje zamówienie przez http rejestru na domyślny adres API', async () => {
    const db = bazaZKluczem();
    const { http, wywolania } = atrapaHttp();
    const uslugi = createFabrykaErli({ db, teraz: () => TERAZ })({ polaczenie, http, httpAutoryzacji: http, sprawdzZapis: () => {} });
    await uslugi.poller.przebieg();
    expect(db.prepare("SELECT COUNT(*) AS n FROM zamowienia WHERE sklep = 'erli_pc'").get().n).toBe(1);
    expect(wywolania.map(w => w.sciezka)).toContain('/svc/shop-api/orders/changes/mark-read');
    expect(wywolania.every(w => w.autoryzacja === `Bearer ${KLUCZ_TESTOWY}`)).toBe(true);
    expect(uslugi.poller.stan()).toMatchObject({ sklep: 'erli_pc', tor_importu: 'zmiany' });
    expect(uwagaToruErli(uslugi.poller.stan())).toBeNull();
  });

  it('404 na /orders/changes → tor inbox w stanie pollera i uwaga w diagnostyce (bez klucza API)', async () => {
    const db = bazaZKluczem({ adresApi: 'https://sandbox.erli.dev/svc/shop-api' });
    const { http, wywolania } = atrapaHttp({ zmiany404: true });
    const uslugi = createFabrykaErli({ db, teraz: () => TERAZ })({ polaczenie, http, httpAutoryzacji: http, sprawdzZapis: () => {} });
    await uslugi.poller.przebieg();
    expect(wywolania[0].sciezka).toBe('/svc/shop-api/orders/changes/_search');
    expect(wywolania.map(w => w.sciezka)).toContain('/svc/shop-api/inbox/_search');
    const stan = uslugi.poller.stan();
    expect(stan.tor_importu).toBe('inbox');
    const uwaga = uwagaToruErli(stan);
    expect(uwaga).toMatch(/erli_pc/);
    expect(uwaga).toMatch(/\/inbox/);
    expect(uwaga).not.toContain(KLUCZ_TESTOWY);
  });

  it('błąd uzgodnienia (orders/_search) nie zatrzymuje importu i jest w stanie pollera bez klucza API', async () => {
    const db = bazaZKluczem();
    const { http } = atrapaHttp();
    const httpZBledem = async (url, init) => (String(url).endsWith('/orders/_search')
      ? new Response(JSON.stringify({ message: 'za dużo' }), { status: 429, headers: { 'content-type': 'application/json' } })
      : http(url, init));
    const uslugi = createFabrykaErli({ db, teraz: () => TERAZ })({ polaczenie, http: httpZBledem, httpAutoryzacji: httpZBledem, sprawdzZapis: () => {} });
    await uslugi.poller.przebieg();
    expect(db.prepare("SELECT COUNT(*) AS n FROM zamowienia WHERE sklep = 'erli_pc'").get().n).toBe(1);
    const stan = uslugi.poller.stan();
    expect(stan.uzgodnienie_blad).toMatch(/429/);
    expect(stan.uzgodnienie_blad).not.toContain(KLUCZ_TESTOWY);
  });

  it('uwaga toru dotyczy tylko stanów z torem inbox', () => {
    expect(uwagaToruErli({ sklep: 'woo_pc', ostatni_blad: null })).toBeNull();
    expect(uwagaToruErli({ sklep: 'erli_pc', tor_importu: 'zmiany' })).toBeNull();
  });
});
