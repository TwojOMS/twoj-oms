// Klient Woo: zapis ceny regularnej hurtem, zmiana statusu produktu i odczyt powiązanych szkiców.
// Każde żądanie przechodzi przez nagrany `fetchImpl`, który rzuca przy adresie spoza nagrania —
// nic nie może wyjść poza test.
import { describe, expect, it } from 'vitest';
import { createWooClient } from '../../src/oms/woo/client.js';

const BAZA = 'https://sklep.polcien.invalid';
const REST = `${BAZA}/wp-json/wc/v3`;

function odpowiedz(status, dane, naglowki = {}) {
  return {
    ok: status >= 200 && status < 300,
    status,
    headers: { get: (n) => naglowki[n.toLowerCase()] ?? null },
    json: async () => dane,
  };
}

/**
 * `nagranie` dostaje { metoda, sciezka, parametry, cialo, n } i zwraca odpowiedź albo `undefined`
 * (= nieznany adres → wyjątek, żeby żądanie spoza nagrania nie przeszło po cichu).
 */
function klient(nagranie, opcje = {}) {
  const zadania = [];
  const fetchImpl = async (url, init = {}) => {
    const u = new URL(url);
    if (u.origin !== BAZA || !u.pathname.startsWith('/wp-json/wc/v3/')) throw new Error(`Nieznany adres ${url}`);
    const z = {
      metoda: init.method ?? 'GET',
      sciezka: u.pathname.slice('/wp-json/wc/v3'.length),
      parametry: Object.fromEntries(u.searchParams),
      cialo: init.body === undefined ? undefined : JSON.parse(init.body),
      n: zadania.length + 1,
    };
    zadania.push(z);
    const odp = nagranie(z);
    if (!odp) throw new Error(`Nieznany adres ${z.metoda} ${url}`);
    return odp;
  };
  return { zadania, woo: createWooClient({ baseUrl: BAZA, ck: 'test', cs: 'test', fetchImpl, ...opcje }) };
}

const echoBatch = ({ metoda, sciezka, cialo }) =>
  metoda === 'POST' && sciezka.endsWith('/batch') ? odpowiedz(200, { update: cialo.update }) : undefined;

const pozycje = (n, od = 9000) => Array.from({ length: n }, (_, i) => ({ id: od + i, regular_price: '110.00' }));

describe('zapiszCenyHurtem — biała lista id + regular_price', () => {
  it('batch niesie dokładnie {update:[{id, regular_price}]} i nic więcej', async () => {
    const { woo, zadania } = klient(echoBatch);
    expect(await woo.zapiszCenyHurtem(null, [{ id: 1101, regular_price: '110.00' }])).toEqual([{ id: 1101, ok: true }]);
    expect(zadania).toHaveLength(1);
    expect(zadania[0].metoda).toBe('POST');
    expect(zadania[0].sciezka).toBe('/products/batch');
    expect(zadania[0].cialo).toStrictEqual({ update: [{ id: 1101, regular_price: '110.00' }] });
  });

  it('wariant idzie pod /products/{rodzic}/variations/batch', async () => {
    const { woo, zadania } = klient(echoBatch);
    await woo.zapiszCenyHurtem(7000, [{ id: 70001, regular_price: '39.90' }]);
    expect(zadania.map((z) => z.sciezka)).toEqual(['/products/7000/variations/batch']);
    expect(zadania[0].cialo).toStrictEqual({ update: [{ id: 70001, regular_price: '39.90' }] });
  });

  it('udana odpowiedź zwraca aktualną cenę produktu, także gdy trwa promocja', async () => {
    const { woo } = klient(() =>
      odpowiedz(200, { update: [{ id: 1101, regular_price: '110.00', sale_price: '79.50', price: '79.50' }] }),
    );
    expect(await woo.zapiszCenyHurtem(null, [{ id: 1101, regular_price: '110.00' }])).toEqual([
      { id: 1101, ok: true, cena: '79.50' },
    ]);
  });

  it('230 pozycji = 3 żądania po 100/100/30', async () => {
    const { woo, zadania } = klient(echoBatch);
    const lista = pozycje(230);
    const wynik = await woo.zapiszCenyHurtem(null, lista);
    expect(zadania.map((z) => z.cialo.update.length)).toEqual([100, 100, 30]);
    expect(zadania.flatMap((z) => z.cialo.update)).toStrictEqual(lista);
    expect(wynik).toEqual(lista.map(({ id }) => ({ id, ok: true })));
  });

  it.each(['sale_price', 'price', 'status', 'stock_quantity', 'name', 'date_on_sale_to'])(
    'pole %s w ostatniej pozycji → wyjątek przed pierwszym żądaniem',
    async (pole) => {
      const { woo, zadania } = klient(echoBatch);
      await expect(
        woo.zapiszCenyHurtem(null, [...pozycje(150), { id: 9999, regular_price: '110.00', [pole]: '99.00' }]),
      ).rejects.toThrow(/pole/i);
      expect(zadania).toHaveLength(0);
    },
  );

  it.each([['110'], ['110.0'], ['110,00'], ['0.00'], ['-1.00'], [''], [110], [null], ['1e3.00'], [' 1.00']])(
    'cena %j odrzucona przed pierwszym żądaniem',
    async (cena) => {
      const { woo, zadania } = klient(echoBatch);
      await expect(woo.zapiszCenyHurtem(null, [...pozycje(120), { id: 9999, regular_price: cena }])).rejects.toThrow(
        /cen/i,
      );
      expect(zadania).toHaveLength(0);
    },
  );

  it('zły identyfikator pozycji albo rodzica → wyjątek bez żądania', async () => {
    const { woo, zadania } = klient(echoBatch);
    await expect(woo.zapiszCenyHurtem(null, [{ id: '5/../orders', regular_price: '1.00' }])).rejects.toThrow();
    await expect(woo.zapiszCenyHurtem('7000/../orders', [{ id: 1, regular_price: '1.00' }])).rejects.toThrow();
    expect(zadania).toHaveLength(0);
  });

  it('jedna paczka 500 → tylko ona ok:false, pozostałe ok', async () => {
    const { woo, zadania } = klient((z) => (z.n === 2 ? odpowiedz(500, { message: 'Błąd serwera' }) : echoBatch(z)));
    const wynik = await woo.zapiszCenyHurtem(null, pozycje(230));
    expect(zadania).toHaveLength(3);
    expect(wynik.slice(0, 100).every((w) => w.ok)).toBe(true);
    expect(wynik.slice(100, 200).every((w) => !w.ok && /500/.test(w.blad))).toBe(true);
    expect(wynik.slice(200).every((w) => w.ok)).toBe(true);
  });

  it('błąd pozycji w odpowiedzi i brak pozycji w odpowiedzi nie udają sukcesu', async () => {
    const { woo } = klient(() =>
      odpowiedz(200, {
        update: [{ id: 9000 }, { id: 0, error: { message: 'Nieprawidłowa cena', data: { id: 9001 } } }],
      }),
    );
    expect(await woo.zapiszCenyHurtem(null, pozycje(3))).toEqual([
      { id: 9000, ok: true },
      { id: 9001, ok: false, blad: 'Nieprawidłowa cena' },
      { id: 9002, ok: false, blad: expect.any(String) },
    ]);
  });

  it('przekierowanie na inny adres i klucz bez prawa zapisu przerywają całość', async () => {
    const { woo } = klient(
      (z) => (z.n === 2 ? odpowiedz(307, null, { location: 'https://obcy.invalid/x' }) : echoBatch(z)),
      { tylkoTenSamOrigin: true },
    );
    await expect(woo.zapiszCenyHurtem(null, pozycje(150))).rejects.toMatchObject({ name: 'WooInnyOrigin' });
    const { woo: bezZapisu } = klient(() =>
      odpowiedz(401, {
        code: 'woocommerce_rest_authentication_error',
        message: 'The API key provided does not have write permissions.',
      }),
    );
    await expect(bezZapisu.zapiszCenyHurtem(null, pozycje(2))).rejects.toMatchObject({ name: 'WooKluczTylkoOdczyt' });
  });

  it('pusta lista nie robi żądania', async () => {
    const { woo, zadania } = klient(echoBatch);
    expect(await woo.zapiszCenyHurtem(null, [])).toEqual([]);
    expect(zadania).toHaveLength(0);
  });
});

describe('ustawStatusProduktu — tylko publish/draft, ciało {status}', () => {
  it.each(['draft', 'publish'])('%s: PUT /products/{id} z ciałem dokładnie {status}', async (status) => {
    const { woo, zadania } = klient(({ metoda, sciezka, cialo }) =>
      metoda === 'PUT' && sciezka === '/products/1101'
        ? odpowiedz(200, { id: 1101, sku: 'LP-40', ...cialo })
        : undefined,
    );
    expect(await woo.ustawStatusProduktu(1101, status)).toMatchObject({ id: 1101, status });
    expect(zadania).toHaveLength(1);
    expect(zadania[0].cialo).toStrictEqual({ status });
  });

  it.each(['pending', 'private', 'trash', 'future', '', null, 'Draft'])(
    'status %j → wyjątek bez żądania',
    async (s) => {
      const { woo, zadania } = klient(() => odpowiedz(200, {}));
      await expect(woo.ustawStatusProduktu(1101, s)).rejects.toThrow(/status/i);
      expect(zadania).toHaveLength(0);
    },
  );

  it('identyfikator spoza liczb (wariant, ścieżka) → wyjątek bez żądania', async () => {
    const { woo, zadania } = klient(() => odpowiedz(200, {}));
    await expect(woo.ustawStatusProduktu('1101/variations/5', 'draft')).rejects.toThrow();
    await expect(woo.ustawStatusProduktu('../orders/5', 'draft')).rejects.toThrow();
    expect(zadania).toHaveLength(0);
  });
});

describe('klucz „Odczyt”', () => {
  it('oba zapisy odmawiają bez żadnego żądania', async () => {
    const { woo, zadania } = klient(echoBatch, { uprawnienia: 'odczyt' });
    await expect(woo.zapiszCenyHurtem(null, pozycje(2))).rejects.toMatchObject({ name: 'WooTylkoOdczyt' });
    await expect(woo.ustawStatusProduktu(1101, 'draft')).rejects.toMatchObject({ name: 'WooTylkoOdczyt' });
    expect(zadania).toHaveLength(0);
  });
});

describe('pobierzProduktyPowiazane — tylko szkice, po include', () => {
  const nagranieSzkicow = ({ metoda, sciezka, parametry }) =>
    metoda === 'GET' && sciezka === '/products'
      ? odpowiedz(
          200,
          parametry.include.split(',').map((id) => ({ id: Number(id), status: 'draft', type: 'simple' })),
        )
      : undefined;

  it('URL ma status=draft, include i per_page=100; 230 id = 3 żądania', async () => {
    const { woo, zadania } = klient(nagranieSzkicow);
    const ids = Array.from({ length: 230 }, (_, i) => 5000 + i);
    const wynik = await woo.pobierzProduktyPowiazane(ids);
    expect(wynik.map((p) => p.id)).toEqual(ids);
    expect(zadania.map((z) => z.parametry.status)).toEqual(['draft', 'draft', 'draft']);
    expect(zadania.map((z) => z.parametry.per_page)).toEqual(['100', '100', '100']);
    expect(zadania.map((z) => z.parametry.include.split(',').length)).toEqual([100, 100, 30]);
  });

  it('odczyt działa też przy kluczu „Odczyt” — to nie zapis', async () => {
    const { woo, zadania } = klient(nagranieSzkicow, { uprawnienia: 'odczyt' });
    expect(await woo.pobierzProduktyPowiazane([5000])).toEqual([{ id: 5000, status: 'draft', type: 'simple' }]);
    expect(zadania).toHaveLength(1);
  });

  it('pusta lista bez żądania; zły id i odpowiedź nie-lista → wyjątek', async () => {
    const { woo, zadania } = klient(() => odpowiedz(200, { message: 'konserwacja' }));
    expect(await woo.pobierzProduktyPowiazane([])).toEqual([]);
    expect(zadania).toHaveLength(0);
    await expect(woo.pobierzProduktyPowiazane(['1/../orders'])).rejects.toThrow();
    expect(zadania).toHaveLength(0);
    await expect(woo.pobierzProduktyPowiazane([5000])).rejects.toThrow(/list/i);
  });

  it('fetchImpl rzuca przy nieznanym adresie (nagranie jest szczelne)', async () => {
    const { woo } = klient(() => undefined);
    await expect(woo.pobierzProduktyPowiazane([5000])).rejects.toThrow(/Nieznany adres/);
  });
});
