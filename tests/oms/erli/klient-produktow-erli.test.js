import { describe, it, expect, vi } from 'vitest';
import { readFileSync } from 'node:fs';
import { createErliClient, czyDozwoloneZadanieProduktu } from '../../../src/oms/erli/client.js';

const f = JSON.parse(readFileSync(new URL('./fixtures/produkty-prz160e2.json', import.meta.url), 'utf8'));
const baza = 'https://polcien.example/api';
function przygotuj(odpowiedzi = [[202, f.przyjeto]]) {
  let i = 0;
  const fetchImpl = vi.fn(async () => {
    const [status, body, headers] = odpowiedzi[Math.min(i++, odpowiedzi.length - 1)];
    return new Response(body === undefined ? null : JSON.stringify(body), { status, headers });
  });
  const czekaj = vi.fn(async () => {});
  return {
    klient: createErliClient({ adresApi: baza, kluczApi: 'fikcyjny-klucz', wersja: 'test', fetchImpl, czekaj }),
    fetchImpl,
    czekaj,
  };
}

describe('produkty ERLI (syntetyczne odpowiedzi P1/P3/P6/P-arch)', () => {
  it.each([
    ['utworzProdukt', ['LMP-01/a', f.produkt], 'POST', '/products/LMP-01%2Fa', f.produkt, f.przyjeto],
    ['zmienProdukt', ['LMP-01', { stock: 4 }], 'PATCH', '/products/LMP-01', { stock: 4 }, f.zamrozone],
    [
      'szukajProduktow',
      [{ pagination: { limit: 10 } }],
      'POST',
      '/products/_search',
      { pagination: { limit: 10 } },
      f.odczyt,
    ],
    [
      'zmienProdukty',
      [[{ externalId: 'LMP-01', stock: 4 }]],
      'PATCH',
      '/products/batch-update',
      [{ externalId: 'LMP-01', stock: 4 }],
      [f.batch[1]],
    ],
  ])('%s: metoda, ścieżka, nagłówki, ciało i 202 z ciałem', async (metoda, args, http, path, body, wynik) => {
    const { klient, fetchImpl } = przygotuj([[202, wynik]]);
    expect(await klient[metoda](...args)).toEqual(wynik);
    const [url, init] = fetchImpl.mock.calls[0];
    expect(url).toBe(baza + path);
    expect(init.method).toBe(http);
    expect(JSON.parse(init.body)).toEqual(body);
    expect(init.headers.get('Authorization')).toBe('Bearer fikcyjny-klucz');
    expect(init.headers.get('Accept')).toBe('application/json');
    expect(init.headers.get('Content-Type')).toBe('application/json');
    expect(init.headers.get('User-Agent')).toBe('TwojOMS/test (+https://twojoms.pl)');
    expect(init.body).not.toContain('archived');
  });

  it('biała lista dopuszcza wyłącznie cztery kombinacje produktów', () => {
    const dozwolone = new Set([
      'POST /products/LMP-01',
      'PATCH /products/LMP-01',
      'POST /products/_search',
      'PATCH /products/batch-update',
    ]);
    for (const method of ['GET', 'POST', 'PATCH', 'PUT', 'DELETE', 'HEAD', 'OPTIONS']) {
      for (const path of [
        '/products/LMP-01',
        '/products/_search',
        '/products/batch-update',
        '/products',
        '/products/',
        '/products/..',
        '/products/LMP-01/status',
        '/orders/LMP-01',
        '/products/_delete',
      ]) {
        expect(czyDozwoloneZadanieProduktu(method, path), `${method} ${path}`).toBe(dozwolone.has(`${method} ${path}`));
      }
    }
  });

  it.each(['', '.', '..', '_search', 'batch-update', '_delete'])(
    'odrzuca zastrzeżony identyfikator %j przed siecią',
    async (id) => {
      const { klient, fetchImpl } = przygotuj();
      await expect(klient.utworzProdukt(id, {})).rejects.toThrow(/identyfikator|dozwolon/i);
      await expect(klient.zmienProdukt(id, {})).rejects.toThrow(/identyfikator|dozwolon/i);
      expect(fetchImpl).not.toHaveBeenCalled();
    },
  );

  it.each([{ archived: true }, { archived: false }, { x: [{ y: { archived: null } }] }])(
    'archived na dowolnym poziomie blokuje każde żądanie: %j',
    async (body) => {
      const { klient, fetchImpl } = przygotuj();
      for (const [metoda, args] of [
        ['utworzProdukt', ['LMP-01', body]],
        ['zmienProdukt', ['LMP-01', body]],
        ['zmienProdukty', [[{ externalId: 'LMP-01', ...body }]]],
        ['szukajProduktow', [body]],
        ['szukajZamowien', [body]],
      ])
        await expect(klient[metoda](...args)).rejects.toThrow(/archived/i);
      expect(fetchImpl).not.toHaveBeenCalled();
    },
  );

  it('sprawdza też archived w postaci zwracanej przez toJSON', async () => {
    const { klient, fetchImpl } = przygotuj();
    await expect(klient.utworzProdukt('LMP-01', { toJSON: () => ({ archived: true }) })).rejects.toThrow(/archived/i);
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it('nowa powierzchnia klienta to wyłącznie cztery metody produktów', () => {
    expect(Object.keys(przygotuj().klient).sort()).toEqual(
      [
        'mojSklep',
        'zmianyZamowien',
        'oznaczPrzeczytane',
        'inboxSzukaj',
        'inboxOznacz',
        'pobierzProdukt',
        'szukajZamowien',
        'pobierzZamowienie',
        'ustawStatusSprzedawcy',
        'utworzPaczkiZewnetrzne',
        'edytujPaczkeZewnetrzna',
        'usunPaczkeZewnetrzna',
        'metodyDostawy',
        'metodyErli',
        'cennikiDostaw',
        'cennikiDostawSzczegoly',
        'punktyNadania',
        'utworzPaczki',
        'szukajPaczek',
        'anulujPaczke',
        'protokolyOdbioru',
        'pobierzEtykiete',
        'utworzProdukt',
        'zmienProdukt',
        'zmienProdukty',
        'szukajProduktow',
      ].sort(),
    );
  });

  it('błąd niesie treść odpowiedzi bez odbitych wartości żądania', async () => {
    const body = { name: 'Lampa "Półcień" LMP-01' };
    const { klient } = przygotuj([[400, { message: body.name }]]);
    await expect(klient.utworzProdukt('LMP-01', body)).rejects.toMatchObject({ odpowiedz: { message: '[ukryto]' } });
  });

  it.each([
    ['2', [2000, 2000]],
    [undefined, [1000, 2000]],
  ])('429 ponawia przez czekaj, Retry-After=%j', async (retry, odstepy) => {
    const { klient, fetchImpl, czekaj } = przygotuj([
      [429, {}, retry ? { 'Retry-After': retry } : {}],
      [429, {}, retry ? { 'Retry-After': retry } : {}],
      [202, f.przyjeto],
    ]);
    expect(await klient.utworzProdukt('LMP-01', f.produkt)).toEqual(f.przyjeto);
    expect(czekaj.mock.calls.map(([ms]) => ms)).toEqual(odstepy);
    expect(fetchImpl).toHaveBeenCalledTimes(3);
    expect(fetchImpl.mock.calls.map(([, init]) => init.body)).toEqual(Array(3).fill(JSON.stringify(f.produkt)));
  });

  it('Retry-After ponad 60 s oddaje 429 wywołującemu bez czekania, a echo klucza w pozycji batch jest ukryte', async () => {
    const { klient, czekaj } = przygotuj([[429, {}, { 'Retry-After': '86400' }]]);
    await expect(klient.szukajProduktow({})).rejects.toMatchObject({ status: 429 });
    expect(czekaj).not.toHaveBeenCalled();
    const b = przygotuj([[202, [{ externalId: 'LMP-01', status: 400, message: 'zły fikcyjny-klucz' }]]]);
    const [w] = await b.klient.zmienProdukty([{ externalId: 'LMP-01', stock: 1 }]);
    expect([w.blad.message, w.blad.odpowiedz.message]).toEqual(['zły [ukryto]', 'zły [ukryto]']);
  });

  it('Retry-After obsługuje datę HTTP', async () => {
    vi.spyOn(Date, 'now').mockReturnValue(Date.parse('2026-11-13T10:00:00Z'));
    try {
      const { klient, czekaj } = przygotuj([
        [429, {}, { 'Retry-After': 'Fri, 13 Nov 2026 10:00:03 GMT' }],
        [202, f.przyjeto],
      ]);
      await klient.zmienProdukt('LMP-01', { stock: 4 });
      expect(czekaj).toHaveBeenCalledWith(3000);
    } finally {
      vi.restoreAllMocks();
    }
  });

  it('429 ma limit trzech prób', async () => {
    const { klient, fetchImpl, czekaj } = przygotuj([[429, {}]]);
    await expect(klient.szukajProduktow()).rejects.toMatchObject({ status: 429, kod: 'ERLI_429', chwilowy: true });
    expect(fetchImpl).toHaveBeenCalledTimes(3);
    expect(czekaj.mock.calls).toEqual([[1000], [2000]]);
  });

  it.each([400, 404, 409, 500, 503])('HTTP %i: klasyfikacja i treść bez automatycznego PATCH', async (status) => {
    const body = status === 409 ? f.konflikt : f.walidacja;
    const { klient, fetchImpl } = przygotuj([[status, body]]);
    await expect(klient.utworzProdukt('LMP-01', f.produkt)).rejects.toMatchObject({
      status,
      chwilowy: status >= 500,
      kod: `ERLI_${status}`,
      odpowiedz: body,
    });
    expect(fetchImpl).toHaveBeenCalledTimes(1);
  });

  it('batch mapuje po externalId, a 400 jest błędem tylko swojej pozycji', async () => {
    const { klient } = przygotuj([[202, f.batch]]);
    const wynik = await klient.zmienProdukty([
      { externalId: 'LMP-01', stock: 4 },
      { externalId: 'LMP-02', stock: 5 },
    ]);
    expect(wynik[0]).toEqual(f.batch[1]);
    expect(wynik[1]).toMatchObject({
      ...f.batch[0],
      blad: { status: 400, chwilowy: false, kod: 'ERLI_400', message: 'Produkt nie istnieje' },
    });
  });

  it('wynik batch z cudzym externalId to niekompletny wynik, nie TypeError', async () => {
    const { klient } = przygotuj([
      [
        202,
        [
          { externalId: 'LMP-01', status: 200 },
          { externalId: 'LMP-99', status: 200 },
        ],
      ],
    ]);
    await expect(
      klient.zmienProdukty([
        { externalId: 'LMP-01', stock: 4 },
        { externalId: 'LMP-02', stock: 5 },
      ]),
    ).rejects.toThrow('niekompletny wynik');
  });

  it('brak wyniku pozycji batch nie udaje sukcesu', async () => {
    const { klient } = przygotuj([[202, []]]);
    await expect(klient.zmienProdukty([{ externalId: 'LMP-01', stock: 4 }])).rejects.toThrow(/wynik/i);
  });
});
