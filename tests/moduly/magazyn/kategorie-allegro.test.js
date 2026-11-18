// Dwa odczyty kategorii w kliencie Allegro i pamięć podręczna `kanaly_kategorie`
// (jeden wiersz na kategorię i połączenie). Prawdziwy klient na wstrzykniętym `fetch`, baza w pamięci z migracjami.
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { createAllegroClient } from '../../../src/oms/allegro/client.js';
import { openOmsDb } from '../../../src/oms/db/db.ts';
import {
  opisKategoriiAllegro,
  kontoOpisuSrodowiska,
  szukajWartosciSlownika,
} from '../../../src/moduly/magazyn/services/kategorie-allegro.js';
import { readFileSync } from 'node:fs';
import { PROG_SLOWNIKA } from '../../../src/domena/tresc-oferty-allegro.js';

const tokeny = { waznyToken: async () => 'TOKEN' };
const ustawienia = {
  api: 'https://api.przyklad',
  userAgent: 'PrzykladowyPanel/0.0.0 (+https://przyklad.invalid/panel)',
};
const KATEGORIE = {
  5: { id: '5', name: 'Dom i Ogród', parent: null, leaf: false },
  256: { id: '256', name: 'Oświetlenie', parent: { id: '5' }, leaf: false },
  257: { id: '257', name: 'Lampy', parent: { id: '256' }, leaf: true },
};
const PARAMETRY = {
  parameters: [
    {
      id: '248811',
      name: 'Marka',
      type: 'dictionary',
      unit: null,
      options: { describesProduct: true },
      dictionary: Array.from({ length: PROG_SLOWNIKA + 100 }, (_, i) => ({ id: `248811_${i}`, value: `Marka ${i}` })),
    },
    { id: '225693', name: 'EAN (GTIN)', type: 'string', unit: null, options: { describesProduct: true } },
    {
      id: '11323',
      name: 'Stan',
      type: 'dictionary',
      unit: null,
      options: { describesProduct: false },
      dictionary: [{ id: '11323_1', value: 'Nowy' }],
    },
  ],
};

const ok = (cialo) => ({ ok: true, status: 200, json: async () => cialo, headers: new Headers() });
const blad = (status) => ({
  ok: false,
  status,
  json: async () => ({ errors: [{ message: 'Odmowa' }] }),
  headers: new Headers(),
});

function kontoAllegro({
  parametry = () => ok(PARAMETRY),
  kategoria = (id) => (KATEGORIE[id] ? ok(KATEGORIE[id]) : blad(404)),
} = {}) {
  return vi.fn(async (url) => {
    const sciezka = new URL(url).pathname;
    const m = /^\/sale\/categories\/([^/]+)(\/parameters)?$/.exec(sciezka);
    if (!m) throw new Error(`Test nie zna adresu ${sciezka}`);
    return m[2] ? parametry(decodeURIComponent(m[1])) : kategoria(decodeURIComponent(m[1]));
  });
}
const klient = (fetchImpl) => createAllegroClient({ ustawienia, tokeny, fetchImpl });
const sciezki = (fetchImpl) => fetchImpl.mock.calls.map(([url]) => new URL(url).pathname);
const teraz = () => new Date('2026-11-12T10:00:00.000Z');

let db;
beforeEach(() => {
  db = openOmsDb(':memory:');
});
afterEach(() => {
  db?.close();
  db = null;
});

describe('klient Allegro — odczyt kategorii (tylko GET)', () => {
  it('pobierzKategorie i pobierzParametryKategorii czytają GET-em z limitem czasu i kodują id', async () => {
    const fetchImpl = vi.fn(async () => ok({ id: 'x' }));
    const k = klient(fetchImpl);
    await k.pobierzKategorie('25/7?a');
    await k.pobierzParametryKategorii('257');
    expect(fetchImpl.mock.calls.map(([url]) => url)).toEqual([
      'https://api.przyklad/sale/categories/25%2F7%3Fa',
      'https://api.przyklad/sale/categories/257/parameters',
    ]);
    for (const [, opcje] of fetchImpl.mock.calls) {
      expect(opcje.method).toBe('GET');
      expect(opcje.signal).toBeInstanceOf(AbortSignal);
    }
  });
  it('błąd HTTP niesie kod (żeby odmowę zakresu dało się pominąć)', async () => {
    await expect(klient(vi.fn(async () => blad(403))).pobierzKategorie('257')).rejects.toMatchObject({ status: 403 });
  });
});

describe('pamięć podręczna kategorii (kanaly_kategorie)', () => {
  it('pierwszy odczyt idzie po rodzicach, zapisuje jeden wiersz bez dużego słownika; drugi nie pyta Allegro', async () => {
    const fetchImpl = kontoAllegro();
    const opis = await opisKategoriiAllegro({
      db,
      klient: klient(fetchImpl),
      polaczenie: 'allegro_polcien',
      kategoriaId: '257',
      teraz,
    });
    expect(opis.sciezka).toEqual([
      { id: '5', nazwa: 'Dom i Ogród' },
      { id: '256', nazwa: 'Oświetlenie' },
      { id: '257', nazwa: 'Lampy' },
    ]);
    expect(opis.parametry.map((p) => [p.id, p.opisujeProdukt, p.slownik?.length ?? null])).toEqual([
      ['248811', true, null],
      ['225693', true, null],
      ['11323', false, 1],
    ]);
    expect(sciezki(fetchImpl)).toEqual([
      '/sale/categories/257',
      '/sale/categories/256',
      '/sale/categories/5',
      '/sale/categories/257/parameters',
    ]);

    const wiersze = db.prepare('SELECT * FROM kanaly_kategorie').all();
    expect(wiersze).toHaveLength(1);
    expect(wiersze[0]).toMatchObject({
      polaczenie: 'allegro_polcien',
      kategoria_id: '257',
      pobrano_at: '2026-11-12T10:00:00.000Z',
    });
    expect(wiersze[0].parametry_json).not.toContain('Marka 250');
    expect(wiersze[0].parametry_json.length).toBeLessThan(2000);

    const drugi = kontoAllegro();
    expect(
      await opisKategoriiAllegro({
        db,
        klient: klient(drugi),
        polaczenie: 'allegro_polcien',
        kategoriaId: '257',
        teraz,
      }),
    ).toEqual(opis);
    expect(drugi).not.toHaveBeenCalled();
  });
  it('pamięć jest osobna dla każdego połączenia', async () => {
    await opisKategoriiAllegro({
      db,
      klient: klient(kontoAllegro()),
      polaczenie: 'allegro_a',
      kategoriaId: '257',
      teraz,
    });
    const drugie = kontoAllegro();
    await opisKategoriiAllegro({ db, klient: klient(drugie), polaczenie: 'allegro_b', kategoriaId: '257', teraz });
    expect(drugie).toHaveBeenCalled();
    expect(db.prepare('SELECT count(*) AS n FROM kanaly_kategorie').get().n).toBe(2);
  });
  it.each([401, 403])(
    'odmowa %i (brak zakresu) przy parametrach: ścieżka bez parametrów, nic nie zapisane, bez wyjątku',
    async (status) => {
      const fetchImpl = kontoAllegro({ parametry: () => blad(status) });
      const opis = await opisKategoriiAllegro({
        db,
        klient: klient(fetchImpl),
        polaczenie: 'allegro_polcien',
        kategoriaId: '257',
        teraz,
      });
      expect(opis).toEqual({
        wersja: 2,
        lisc: true,
        tworzenieProduktu: false,
        sciezka: [
          { id: '5', nazwa: 'Dom i Ogród' },
          { id: '256', nazwa: 'Oświetlenie' },
          { id: '257', nazwa: 'Lampy' },
        ],
        parametry: [],
      });
      expect(db.prepare('SELECT count(*) AS n FROM kanaly_kategorie').get().n).toBe(0);
    },
  );
  it('odmowa przy samej kategorii: null, nic nie zapisane, bez wyjątku', async () => {
    const fetchImpl = kontoAllegro({ kategoria: () => blad(403) });
    expect(
      await opisKategoriiAllegro({
        db,
        klient: klient(fetchImpl),
        polaczenie: 'allegro_polcien',
        kategoriaId: '257',
        teraz,
      }),
    ).toBeNull();
    expect(db.prepare('SELECT count(*) AS n FROM kanaly_kategorie').get().n).toBe(0);
  });
  it('inny błąd (500) leci dalej — to nie brak zakresu', async () => {
    const fetchImpl = kontoAllegro({ parametry: () => blad(500) });
    await expect(
      opisKategoriiAllegro({ db, klient: klient(fetchImpl), polaczenie: 'allegro_polcien', kategoriaId: '257', teraz }),
    ).rejects.toMatchObject({ status: 500 });
  });
  it('pętla rodziców nie zawiesza odczytu', async () => {
    const fetchImpl = kontoAllegro({
      kategoria: (id) => ok({ id, name: `K${id}`, parent: { id: id === '1' ? '2' : '1' } }),
    });
    const opis = await opisKategoriiAllegro({
      db,
      klient: klient(fetchImpl),
      polaczenie: 'allegro_polcien',
      kategoriaId: '1',
      teraz,
    });
    expect(opis.sciezka.map((k) => k.id)).toEqual(['2', '1']);
    expect(fetchImpl.mock.calls.length).toBeLessThan(5);
  });
  it('brak id kategorii: null bez pytania Allegro', async () => {
    const fetchImpl = kontoAllegro();
    expect(
      await opisKategoriiAllegro({
        db,
        klient: klient(fetchImpl),
        polaczenie: 'allegro_polcien',
        kategoriaId: null,
        teraz,
      }),
    ).toBeNull();
    expect(fetchImpl).not.toHaveBeenCalled();
  });
});

// Opis v2 w pamięci podręcznej, odświeżanie, konto opisu środowiska i wyszukiwarka słownika.
const P9 = JSON.parse(
  readFileSync(new URL('../../fixtures/allegro/e3-pomiar-p9-kategoria.json', import.meta.url), 'utf8'),
);
const KATEGORIE_P9 = Object.fromEntries(P9.sciezka.map((k) => [k.id, k]));
const kontoP9 = () =>
  kontoAllegro({
    parametry: () => ok(structuredClone(P9.parametry)),
    kategoria: (id) => (KATEGORIE_P9[id] ? ok(KATEGORIE_P9[id]) : blad(404)),
  });
const dni = (n) => () => new Date(Date.parse('2026-11-12T10:00:00.000Z') + n * 86_400_000);
const wstawWiersz = (parametry, pobrano = '2026-11-12T10:00:00.000Z') =>
  db
    .prepare(
      `INSERT INTO kanaly_kategorie
  (polaczenie, kategoria_id, sciezka_json, parametry_json, pobrano_at) VALUES ('allegro_polcien', '257', ?, ?, ?)`,
    )
    .run(JSON.stringify([{ id: '257', nazwa: 'Lampy (stare)' }]), JSON.stringify(parametry), pobrano);

describe('opis kategorii v2 w pamięci podręcznej (E3.05)', () => {
  it('fixture P9: „Marka” wymagana dla produktu, liść z tworzeniem produktu; słownik > 200 nie trafia do bazy', async () => {
    const opis = await opisKategoriiAllegro({
      db,
      klient: klient(kontoP9()),
      polaczenie: 'allegro_polcien',
      kategoriaId: '257',
      teraz,
    });
    expect(opis).toMatchObject({ wersja: 2, lisc: true, tworzenieProduktu: true });
    expect(opis.parametry.find((p) => p.id === '248811')).toMatchObject({
      wymagany: true,
      wymaganyDlaProduktu: true,
      slownikWyciety: true,
    });
    const { parametry_json: zapis } = db.prepare('SELECT parametry_json FROM kanaly_kategorie').get();
    expect(zapis).not.toContain('bez marki');
    expect(zapis).not.toContain('Pracownia 001');
    expect(zapis.length).toBeLessThan(5000);
    const drugi = kontoP9();
    expect(
      await opisKategoriiAllegro({
        db,
        klient: klient(drugi),
        polaczenie: 'allegro_polcien',
        kategoriaId: '257',
        teraz: dni(29),
      }),
    ).toEqual(opis);
    expect(drugi).not.toHaveBeenCalled();
  });
  it('wiersz w wersji 1 (sama tablica parametrów) jest pobierany ponownie i nadpisany wersją 2', async () => {
    wstawWiersz([{ id: '248811', nazwa: 'Marka', typ: 'dictionary', opisujeProdukt: true, slownik: null }]);
    const fetchImpl = kontoP9();
    const opis = await opisKategoriiAllegro({
      db,
      klient: klient(fetchImpl),
      polaczenie: 'allegro_polcien',
      kategoriaId: '257',
      teraz,
    });
    expect(fetchImpl).toHaveBeenCalled();
    expect(opis.parametry.find((p) => p.id === '248811').wymaganyDlaProduktu).toBe(true);
    const wiersze = db.prepare('SELECT * FROM kanaly_kategorie').all();
    expect(wiersze).toHaveLength(1);
    expect(JSON.parse(wiersze[0].parametry_json).wersja).toBe(2);
    expect(JSON.parse(wiersze[0].sciezka_json).map((k) => k.nazwa)).toEqual([
      'Dom i Ogród',
      'Oświetlenie',
      'Lampy stołowe',
    ]);
  });
  it('wiersz w wersji 2 starszy niż 30 dni jest pobierany ponownie; 30 dni równo jeszcze nie', async () => {
    await opisKategoriiAllegro({
      db,
      klient: klient(kontoP9()),
      polaczenie: 'allegro_polcien',
      kategoriaId: '257',
      teraz,
    });
    const rowno = kontoP9();
    await opisKategoriiAllegro({
      db,
      klient: klient(rowno),
      polaczenie: 'allegro_polcien',
      kategoriaId: '257',
      teraz: dni(30),
    });
    expect(rowno).not.toHaveBeenCalled();
    const pozniej = kontoP9();
    await opisKategoriiAllegro({
      db,
      klient: klient(pozniej),
      polaczenie: 'allegro_polcien',
      kategoriaId: '257',
      teraz: dni(31),
    });
    expect(pozniej).toHaveBeenCalled();
    expect(db.prepare('SELECT pobrano_at FROM kanaly_kategorie').get().pobrano_at).toBe(dni(31)().toISOString());
  });
  it('nieudane odświeżenie (odmowa albo 500) oddaje stary wiersz zamiast przerywać i niczego nie nadpisuje', async () => {
    wstawWiersz([{ id: '11323', nazwa: 'Stan', opisujeProdukt: false, slownik: null }]);
    for (const status of [403, 500]) {
      const opis = await opisKategoriiAllegro({
        db,
        klient: klient(kontoAllegro({ parametry: () => blad(status) })),
        polaczenie: 'allegro_polcien',
        kategoriaId: '257',
        teraz,
      });
      expect(opis).toEqual({
        wersja: 1,
        lisc: null,
        tworzenieProduktu: null,
        sciezka: [{ id: '257', nazwa: 'Lampy (stare)' }],
        parametry: [{ id: '11323', nazwa: 'Stan', opisujeProdukt: false, slownik: null }],
      });
    }
    expect(JSON.parse(db.prepare('SELECT parametry_json FROM kanaly_kategorie').get().parametry_json)).toHaveLength(1);
  });
});

describe('kontoOpisuSrodowiska (D33)', () => {
  const ODCZYT = ['allegro:api:orders:read', 'allegro:api:sale:offers:read'];
  const konto = (klucz, zmiany = {}) => ({
    klucz,
    srodowisko: 'sandbox',
    autoryzacja: 'polaczone',
    uprawnienia: ODCZYT,
    ...zmiany,
  });

  it('dwa połączone konta środowiska → pierwsze w kolejności kluczy, niezależnie od kolejności listy', () => {
    const konta = [konto('allegro_polcien_b'), konto('allegro_polcien_a')];
    expect(kontoOpisuSrodowiska(konta, 'sandbox').klucz).toBe('allegro_polcien_a');
    expect(kontoOpisuSrodowiska([...konta].reverse(), 'sandbox').klucz).toBe('allegro_polcien_a');
  });
  it('pomija inne środowisko, konto niepołączone i konto bez zgody na odczyt ofert', () => {
    const konta = [
      konto('allegro_a', { srodowisko: 'produkcja' }),
      konto('allegro_b', { autoryzacja: 'wymaga_autoryzacji' }),
      konto('allegro_c', { uprawnienia: ['allegro:api:orders:read'] }),
      konto('allegro_d', { uprawnienia: undefined }),
      konto('allegro_e'),
    ];
    expect(kontoOpisuSrodowiska(konta, 'sandbox').klucz).toBe('allegro_e');
  });
  it('brak pasującego konta → null', () => {
    expect(kontoOpisuSrodowiska([konto('allegro_a')], 'produkcja')).toBeNull();
    expect(kontoOpisuSrodowiska(undefined, 'sandbox')).toBeNull();
  });
});

describe('szukajWartosciSlownika (D36)', () => {
  it('„bez marki” zwraca 248811_958954, bez wielkości liter i spacji brzegowych; nic nie trafia do bazy', async () => {
    const fetchImpl = kontoP9();
    const wynik = await szukajWartosciSlownika({
      klient: klient(fetchImpl),
      kategoriaId: '257',
      parametrId: '248811',
      tekst: '  BEZ marki ',
    });
    expect(wynik).toEqual([{ id: '248811_958954', wartosc: 'bez marki' }]);
    expect(sciezki(fetchImpl)).toEqual(['/sale/categories/257/parameters']);
    expect(db.prepare('SELECT count(*) AS n FROM kanaly_kategorie').get().n).toBe(0);
  });
  it('najwyżej 20 trafień w kolejności słownika; dłuższy tekst zawęża', async () => {
    const wynik = await szukajWartosciSlownika({
      klient: klient(kontoP9()),
      kategoriaId: '257',
      parametrId: '248811',
      tekst: 'pracownia',
    });
    expect(wynik).toHaveLength(20);
    expect(wynik[0]).toEqual({ id: '248811_100001', wartosc: 'Pracownia 001' });
    const dokladne = await szukajWartosciSlownika({
      klient: klient(kontoP9()),
      kategoriaId: '257',
      parametrId: '248811',
      tekst: 'pracownia 150',
    });
    expect(dokladne).toEqual([{ id: '248811_100150', wartosc: 'Pracownia 150' }]);
  });
  it('pusty tekst → [] bez pytania Allegro; nieznany parametr albo bez słownika → []', async () => {
    const fetchImpl = kontoP9();
    expect(
      await szukajWartosciSlownika({
        klient: klient(fetchImpl),
        kategoriaId: '257',
        parametrId: '248811',
        tekst: '  ',
      }),
    ).toEqual([]);
    expect(fetchImpl).not.toHaveBeenCalled();
    expect(
      await szukajWartosciSlownika({ klient: klient(kontoP9()), kategoriaId: '257', parametrId: '999', tekst: 'x' }),
    ).toEqual([]);
    expect(
      await szukajWartosciSlownika({ klient: klient(kontoP9()), kategoriaId: '257', parametrId: '224017', tekst: 'x' }),
    ).toEqual([]);
  });
});
