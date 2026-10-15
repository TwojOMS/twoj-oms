// MINIATURY MAGAZYNU — adres miniatury POCHODZI ZE SKLEPU, a nie z reguły po nazwie pliku.
//
// ⚠️⚠️ USTERKA, KTÓRA TE TESTY PRZYPINAJĄ (zgłoszona przez właściciela, zmierzona na
// produkcji 2026-08-12 na WSZYSTKICH adresach obu sklepów):
//
//   sklep            | zdjęć | miniatura istnieje | 404
//   pro.szkicownia.pl  |   103 |                103 |   0 (0%)
//   szkicownia.pl      |   684 |                 76 | 608 (89%)
//
// Panel miniatury NIE ZAPISYWAŁ — ZGADYWAŁ ją, doklejając `-150x150` do nazwy pliku
// oryginału (`domain/miniatury.js`, `adresMiniatury`). Na PRO zgadywanie trafiało, bo PRO
// akurat ma rozmiar 150×150; szkicownia.pl ma WŁASNY rozmiar miniatury `247x296`, więc
// dziewięć na dziesięć wierszy magazynu pokazywało pustą ramkę. Oryginały są zdrowe —
// wszystkie 684 odpowiadają 200, czyli zgadywanie było jedyną przyczyną.
//
// Źródłem prawdy jest Store API sklepu (`/wp-json/wc/store/v1/products`, BEZ
// uwierzytelniania): przy każdym zdjęciu oddaje gotowy `thumbnail`.
//
// ⚠️ Żadne wywołanie w tym pliku nie dotyka prawdziwego sklepu: `fetch` i klienci są
// atrapami, a baza siedzi w pamięci albo w katalogu tymczasowym.
import { potwierdzOdmoweHistorycznegoSchema } from '../../pomoc/baseline-historyczne.js';
import { describe, it, expect, vi } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { openOmsDb } from '../../../src/oms/db/db.ts';
import { zapiszProduktSklepowy } from '../../../src/oms/db/magazyn.js';
import { miniaturyZeStoreApi } from '../../../src/domena/miniatury.js';
import { createWooClient } from '../../../src/oms/woo/client.js';
import { odswiezMagazyn } from '../../../src/moduly/magazyn/services/magazyn-sync.js';

// Prawdziwe adresy ze szkicownia.pl — ten sklep skaluje miniatury do 247×296, a nie 150×150.
const ORYGINAL = 'https://szkicownia.pl/wp-content/uploads/2024/03/kotwica.jpg';
const MINIATURA = 'https://szkicownia.pl/wp-content/uploads/2024/03/kotwica-247x296.jpg';
// Adres, który wyprodukowałoby ZGADYWANIE po nazwie pliku — i którego w sklepie NIE MA.
const ZGADNIETY = 'https://szkicownia.pl/wp-content/uploads/2024/03/kotwica-150x150.jpg';

// ============================================================================
// DOMENA: odpowiedź Store API → mapa `id produktu` → adres miniatury
// ============================================================================

const produktStore = (id, obrazy) => ({ id, name: `Produkt ${id}`, images: obrazy });

describe('miniaturyZeStoreApi — mapa id → adres miniatury', () => {
  it('bierze `thumbnail` PIERWSZEGO zdjęcia produktu', () => {
    const mapa = miniaturyZeStoreApi([
      produktStore(7179, [{ src: ORYGINAL, thumbnail: MINIATURA }]),
    ]);
    expect(mapa.get('7179')).toBe(MINIATURA);
  });

  // ⚠️ PARA DO TESTU WYŻEJ: produkt, o którego miniaturze Store API nic nie mówi, NIE MA
  // wpisu w mapie. Wpis „na wszelki wypadek" (oryginał, adres zgadnięty, pusty napis)
  // zamieniłby brak wiedzy w twierdzenie — a to jest dokładnie ta usterka, którą naprawiamy.
  it('produkt bez zdjęć i bez `thumbnail` NIE trafia do mapy', () => {
    const mapa = miniaturyZeStoreApi([
      produktStore(1, []),
      produktStore(2, [{ src: ORYGINAL }]),
      produktStore(3, null),
      produktStore(4, [{ src: ORYGINAL, thumbnail: '   ' }]),
    ]);
    expect([...mapa.keys()]).toEqual([]);
  });

  // ⚠️ KLUCZ JEST NAPISEM, bo `produkty_sklepowe.produkt_id` jest kolumną TEXT (identyfikator
  // Allegro przychodzi napisem). Store API oddaje `id` LICZBĄ — mapa kluczowana liczbą
  // rozminęłaby się z lustrem CICHO: `Map` porównuje klucze przez `===`, więc 944 !== '944'
  // i żaden wiersz nie dostałby miniatury.
  it('klucz mapy jest napisem, choć Store API oddaje `id` liczbą', () => {
    const mapa = miniaturyZeStoreApi([produktStore(944, [{ thumbnail: MINIATURA }])]);
    expect(mapa.get('944')).toBe(MINIATURA);
    expect(mapa.get(944)).toBeUndefined();
  });

  // Ten sam warunek, co przy wszystkich pozostałych adresach w tym module: wartość ląduje
  // wprost w atrybucie `src` naszego HTML-a.
  it('adres spoza http(s) nie wchodzi do mapy', () => {
    const mapa = miniaturyZeStoreApi([
      produktStore(5, [{ thumbnail: 'javascript:alert(1)' }]),
      produktStore(6, [{ thumbnail: MINIATURA }]),
    ]);
    expect(mapa.has('5')).toBe(false);
    expect(mapa.get('6')).toBe(MINIATURA);
  });

  // Store API jest cudzym API — odpowiedź o innym kształcie ma dać PUSTĄ mapę (czyli
  // „miniatur nie znamy"), a nie wywalić odczyt katalogu.
  it('odpowiedź, która nie jest listą produktów, daje pustą mapę', () => {
    expect(miniaturyZeStoreApi(null).size).toBe(0);
    expect(miniaturyZeStoreApi({ code: 'rest_no_route' }).size).toBe(0);
    expect(miniaturyZeStoreApi(['śmieć', 42, null]).size).toBe(0);
  });
});

// ============================================================================
// KLIENT: Store API to INNY zasób niż REST v3 i nie wolno go mylić
// ============================================================================

const odp = (cialo, naglowki = {}) => ({
  ok: true,
  status: 200,
  headers: { get: (n) => naglowki[n.toLowerCase()] ?? null },
  json: async () => cialo,
});

const klient = (fetchImpl) =>
  createWooClient({ baseUrl: 'https://szkicownia.test', ck: 'ck_a', cs: 'cs_b', fetchImpl });

describe('pobierzMiniatury — odczyt ze Store API', () => {
  it('pyta pod adresem Store API, a nie pod REST v3', async () => {
    const fetchImpl = vi.fn(async () => odp([produktStore(1, [{ thumbnail: MINIATURA }])]));
    await klient(fetchImpl).pobierzMiniatury();
    const [url] = fetchImpl.mock.calls[0];
    expect(url).toContain('/wp-json/wc/store/v1/products');
    expect(url).not.toContain('/wc/v3');
  });

  // ⚠️ STORE API JEST PUBLICZNE i klucza REST nie zna. Dołożony `Authorization` nie jest tu
  // kosmetyką: to sekret sklepu wysyłany pod zasób, który go nie potrzebuje — a w razie
  // przekierowania na cudzy host jechałby razem z nim.
  it('nie wysyła klucza REST pod publiczny zasób', async () => {
    const fetchImpl = vi.fn(async () => odp([]));
    await klient(fetchImpl).pobierzMiniatury();
    const [, opcje] = fetchImpl.mock.calls[0];
    expect(opcje?.headers?.Authorization).toBeUndefined();
  });

  it('idzie po stronach do końca, wg X-WP-TotalPages', async () => {
    const fetchImpl = vi.fn()
      .mockResolvedValueOnce(odp([produktStore(1, [{ thumbnail: MINIATURA }])], { 'x-wp-totalpages': '2' }))
      .mockResolvedValueOnce(odp([produktStore(2, [{ thumbnail: ORYGINAL }])], { 'x-wp-totalpages': '2' }));
    const mapa = await klient(fetchImpl).pobierzMiniatury();
    expect(fetchImpl).toHaveBeenCalledTimes(2);
    expect([...mapa.keys()]).toEqual(['1', '2']);
    // Sama liczba wywolan nie wystarcza: klient dwa razy pytający o stronę 1 przeszedłby
    // tamtą asercję i po cichu zgubił połowę miniatur.
    expect(fetchImpl.mock.calls.map(([u]) => new URL(u).searchParams.get('page'))).toEqual(['1', '2']);
  });

  // ⚠️ PARA: sklep, który ODMÓWIŁ, ma o tym powiedzieć — decyzję „to tylko miniatury"
  // podejmuje przebieg odczytu (niżej), a nie klient. Klient milczący o 500 zamieniłby
  // awarię sklepu w „ten sklep nie ma miniatur", czyli w stan nieodróżnialny od dzisiejszego.
  it('odmowa sklepu RZUCA, zamiast oddać pustą mapę', async () => {
    const fetchImpl = vi.fn(async () => ({
      ok: false, status: 503, headers: { get: () => null }, json: async () => ({ message: 'serwis' }),
    }));
    await expect(klient(fetchImpl).pobierzMiniatury()).rejects.toThrow(/503/);
  });
});

// ============================================================================
// ODCZYT KATALOGÓW: miniatura ZAPISANA w lustrze
// ============================================================================

const TERAZ = '2026-08-12T10:00:00Z';

const sklepAtrapa = ({ produkty, warianty = {}, miniatury = new Map() }) => ({
  pobierzWszystkieProdukty: vi.fn(async () => produkty),
  pobierzWarianty: vi.fn(async (id) => warianty[id] ?? []),
  pobierzMiniatury: vi.fn(async () => miniatury),
});

const wiersze = (db) => db.prepare(
  'SELECT kanal, produkt_id, wariant_id, miniatura FROM produkty_sklepowe ORDER BY produkt_id, wariant_id',
).all();

describe('odswiezMagazyn — miniatura zapisana, nie zgadnięta', () => {
  // ⚠️⚠️ TO JEST SEDNO CAŁEJ POPRAWKI, przypięte wprost: adres miniatury w lustrze pochodzi
  // ZE SKLEPU (Store API), a NIE z reguły opartej na nazwie pliku. Adresy dobrane tak, żeby
  // te dwa źródła dawały RÓŻNE wyniki — zgadywanie skleiłoby `-150x150`, którego na
  // szkicownia.pl nie ma pod żadnym zdjęciem (608 z 684 adresów = 404).
  it('miniatura pochodzi ze Store API, a nie z reguły po nazwie pliku', async () => {
    const db = openOmsDb(':memory:');
    const sklepy = {
      szkicownia: sklepAtrapa({
        produkty: [{
          id: 7179, type: 'simple', name: 'Kotwica', price: '99',
          images: [{ src: ORYGINAL }],
        }],
        miniatury: new Map([['7179', MINIATURA]]),
      }),
    };
    await odswiezMagazyn({ kanalySklepow: ['pro', 'szkicownia'], kanalyAllegro: ['allegro_szkicownia', 'allegro_amarka'],  db, sklepy, allegro: null, teraz: () => TERAZ });

    expect(wiersze(db)[0].miniatura).toBe(MINIATURA);
    expect(wiersze(db)[0].miniatura).not.toBe(ZGADNIETY);
  });

  // ⚠️ WARIANT BIERZE MINIATURĘ RODZICA i jest to świadome: Store API oddaje zdjęcia na
  // PRODUKCIE (`variations` niosą wyłącznie `id` i atrybuty), a wariant zwykle własnego
  // zdjęcia nie ma. Klucz mapy to więc identyfikator RODZICA, nigdy wariantu.
  it('wariant bierze miniaturę rodzica', async () => {
    const db = openOmsDb(':memory:');
    const sklepy = {
      szkicownia: sklepAtrapa({
        produkty: [{ id: 7179, type: 'variable', name: 'Woodland' }],
        warianty: { 7179: [{ id: 7180, sku: 'W-1', price: '99' }] },
        miniatury: new Map([['7179', MINIATURA]]),
      }),
    };
    await odswiezMagazyn({ kanalySklepow: ['pro', 'szkicownia'], kanalyAllegro: ['allegro_szkicownia', 'allegro_amarka'],  db, sklepy, allegro: null, teraz: () => TERAZ });

    expect(wiersze(db)[0]).toMatchObject({ produkt_id: '7179', wariant_id: '7180', miniatura: MINIATURA });
  });

  // ⚠️⚠️ PARA MILCZENIA — i najważniejsza z nich. Produkt, którego miniatury Store API nie
  // podało (zdjęcie mniejsze niż rozmiar miniatury, świeżo wgrany plik bez przeliczonych
  // wariantów), ma w kolumnie NULL. NIE adres zgadnięty (to on daje 404) i NIE oryginał:
  // 608 oryginałów po ~250 kB to ponad 150 MB na JEDNEJ stronie listy.
  it('produkt bez miniatury w Store API zostaje z pustą kolumną — bez zgadywania i bez oryginału', async () => {
    const db = openOmsDb(':memory:');
    const sklepy = {
      szkicownia: sklepAtrapa({
        produkty: [{ id: 7179, type: 'simple', name: 'Kotwica', price: '99', images: [{ src: ORYGINAL }] }],
        miniatury: new Map(),
      }),
    };
    await odswiezMagazyn({ kanalySklepow: ['pro', 'szkicownia'], kanalyAllegro: ['allegro_szkicownia', 'allegro_amarka'],  db, sklepy, allegro: null, teraz: () => TERAZ });

    const w = wiersze(db)[0];
    expect(w.miniatura).toBe(null);
    // Galeria oryginałów ma zostać nietknięta — brak miniatury nie jest brakiem zdjęcia.
    expect(db.prepare('SELECT zdjecia_json FROM produkty_sklepowe').get().zdjecia_json)
      .toBe(JSON.stringify([ORYGINAL]));
  });

  // ⚠️ AWARIA STORE API NIE MA PRAWA WYWRÓCIĆ ODCZYTU KATALOGÓW. To ta sama zasada, co przy
  // izolacji awarii kanału: kanał, który padł, nie dochodzi do `oznaczZnikniete`, więc awaria
  // OZDOBY (miniatur) zamieniłaby się w oznaczenie całego katalogu jako wycofanego ze sprzedaży.
  it('awaria Store API nie zatrzymuje odczytu — katalog wchodzi, miniatury zostają nieznane', async () => {
    const db = openOmsDb(':memory:');
    const log = vi.fn();
    const sklepy = {
      szkicownia: {
        pobierzWszystkieProdukty: vi.fn(async () => [
          { id: 7179, type: 'simple', name: 'Kotwica', price: '99', images: [{ src: ORYGINAL }] },
        ]),
        pobierzWarianty: vi.fn(async () => []),
        pobierzMiniatury: vi.fn(async () => { throw new Error('Sklep odpowiedział 503'); }),
      },
    };
    const wynik = await odswiezMagazyn({ kanalySklepow: ['pro', 'szkicownia'], kanalyAllegro: ['allegro_szkicownia', 'allegro_amarka'],  db, sklepy, allegro: null, teraz: () => TERAZ, log });

    expect(wynik.kanaly[0]).toMatchObject({ kanal: 'szkicownia', zapisane: 1, blad: null });
    expect(wiersze(db)[0].miniatura).toBe(null);
    // ⚠️ ŚLAD W LOGU JEST CZĘŚCIĄ OCHRONY: miniatury, które po cichu przestały przychodzić,
    // wyglądają na ekranie DOKŁADNIE tak samo jak sklep bez zdjęć.
    expect(log).toHaveBeenCalledWith(expect.stringContaining('miniatur'), expect.stringContaining('503'));
  });

  // ⚠️ PARA DO TESTU WYŻEJ: przy zdrowym Store API log ma MILCZEĆ. Bez tej pary ślad
  // wypisywany zawsze przechodziłby tamten test i zamieniłby dziennik kontenera w szum,
  // w którym prawdziwa awaria jest niewidoczna.
  it('zdrowy odczyt miniatur nie zostawia śladu w logu', async () => {
    const db = openOmsDb(':memory:');
    const log = vi.fn();
    const sklepy = {
      szkicownia: sklepAtrapa({
        produkty: [{ id: 7179, type: 'simple', name: 'Kotwica', price: '99' }],
        miniatury: new Map([['7179', MINIATURA]]),
      }),
    };
    await odswiezMagazyn({ kanalySklepow: ['pro', 'szkicownia'], kanalyAllegro: ['allegro_szkicownia', 'allegro_amarka'],  db, sklepy, allegro: null, teraz: () => TERAZ, log });
    // Asercja na SAMYM milczeniu byłaby spełniona także wtedy, gdyby odczytu miniatur
    // w ogóle nie było — stąd dowód, że ścieżka przebiegła i coś zapisała.
    expect(wiersze(db)[0].miniatura).toBe(MINIATURA);
    expect(log).not.toHaveBeenCalled();
  });

  // ⚠️ ALLEGRO NIE MA STORE API i miniatury nie oddaje w ogóle — jedynym adresem jest
  // `primaryImage.url`. Wariant rozmiaru wyprowadzamy tam PODMIANĄ SEGMENTU ŚCIEŻKI
  // (`/original/` → `/s150/`), co jest CO INNEGO niż doklejanie rozmiaru do nazwy pliku:
  // tamta reguła jest ZMIERZONA na żywych zdjęciach (05.08.2026, wszystkie warianty HTTP 200).
  // Ten test pilnuje, żeby zdjęcie ofert Allegro nie zgasło przy okazji naprawy sklepów.
  it('oferta Allegro zapisuje miniaturę s150, mimo braku Store API', async () => {
    const db = openOmsDb(':memory:');
    const allegro = {
      allegro_szkicownia: {
        pobierzOferty: vi.fn(async () => [{
          id: '17281234', name: 'Szablon kotwica',
          sellingMode: { price: { amount: '89.00', currency: 'PLN' } },
          publication: { status: 'ACTIVE' },
          primaryImage: { url: 'https://9.allegroimg.com/original/03e7d6/772bd11044a79ce6967b62cfa489' },
        }]),
      },
    };
    await odswiezMagazyn({ kanalySklepow: ['pro', 'szkicownia'], kanalyAllegro: ['allegro_szkicownia', 'allegro_amarka'],  db, sklepy: null, allegro, teraz: () => TERAZ });

    expect(wiersze(db)[0].miniatura)
      .toBe('https://9.allegroimg.com/s150/03e7d6/772bd11044a79ce6967b62cfa489');
  });

  // ⚠️ PARA: oferta bez zdjęcia zostaje z pustą kolumną, a nie ze sklejonym adresem —
  // ta sama zasada, co przy sklepie.
  it('oferta Allegro bez zdjęcia zostaje z pustą kolumną', async () => {
    const db = openOmsDb(':memory:');
    const allegro = {
      allegro_szkicownia: {
        pobierzOferty: vi.fn(async () => [{
          id: '17281234', name: 'Szablon kotwica',
          sellingMode: { price: { amount: '89.00', currency: 'PLN' } },
        }]),
      },
    };
    await odswiezMagazyn({ kanalySklepow: ['pro', 'szkicownia'], kanalyAllegro: ['allegro_szkicownia', 'allegro_amarka'],  db, sklepy: null, allegro, teraz: () => TERAZ });
    expect(wiersze(db)[0].miniatura).toBe(null);
  });

  // ⚠️ Kolumna lustra, więc `DO UPDATE SET`: właściciel, który podmienił zdjęcie w sklepie,
  // ma zobaczyć NOWĄ miniaturę po odczycie, a nie starą do końca świata.
  it('kolejny odczyt odświeża miniaturę', async () => {
    const db = openOmsDb(':memory:');
    const inna = 'https://szkicownia.pl/wp-content/uploads/2026/08/nowa-247x296.jpg';
    const przebieg = (mapa) => odswiezMagazyn({ kanalySklepow: ['pro', 'szkicownia'], kanalyAllegro: ['allegro_szkicownia', 'allegro_amarka'], 
      db,
      sklepy: {
        szkicownia: sklepAtrapa({
          produkty: [{ id: 7179, type: 'simple', name: 'Kotwica', price: '99' }],
          miniatury: mapa,
        }),
      },
      allegro: null,
      teraz: () => TERAZ,
    });
    await przebieg(new Map([['7179', MINIATURA]]));
    await przebieg(new Map([['7179', inna]]));
    expect(wiersze(db)[0].miniatura).toBe(inna);
  });
});

// ============================================================================
// LUSTRO: kolumna `miniatura`
// ============================================================================

describe('lustro trzyma adres miniatury we WŁASNEJ kolumnie', () => {
  it('istniejąca baza dostaje kolumnę migracją, a nie dopiero przy zakładaniu od zera', () => {
    // Wyłącznie proponowany wyjątek PRZ026-12: odmowa złego baseline oraz prawdziwy reopen.
    potwierdzOdmoweHistorycznegoSchema(['ALTER TABLE produkty_sklepowe DROP COLUMN miniatura'], ['miniatura']);
    const katalog = mkdtempSync(join(tmpdir(), 'oms-miniatury-'));
    const plik = join(katalog, 'oms.sqlite');
    try {
      const pierwsza = openOmsDb(plik);
      let id;
      try {
        pierwsza.prepare("INSERT INTO wzory(id,nazwa,sku,utworzony_at,zmieniony_at) VALUES(7,'Kotwica','TEST-7','x','x')").run();
        id = zapiszProduktSklepowy(pierwsza, { kanal: 'kanal-testowy', produkt_id: '7179', wariant_id: '',
          nazwa: 'Kotwica produktu', sku_sklepu: 'SKU-TEST', cena_gr: 9900,
          miniatura: MINIATURA, zdjecia_json: JSON.stringify([ORYGINAL]), odczytane_at: TERAZ });
        pierwsza.prepare('UPDATE produkty_sklepowe SET wzor_id=7 WHERE id=?').run(id);
      } finally { pierwsza.close(); }
      const druga = openOmsDb(plik);
      try {
        const kolumny = druga.prepare('PRAGMA table_info(produkty_sklepowe)').all().map((k) => k.name);
        expect(kolumny).toContain('miniatura');
        expect(druga.prepare('SELECT kanal,produkt_id,wariant_id,nazwa,sku_sklepu,cena_gr,miniatura,zdjecia_json,wzor_id FROM produkty_sklepowe WHERE id=?').get(id))
          .toEqual({ kanal: 'kanal-testowy', produkt_id: '7179', wariant_id: '', nazwa: 'Kotwica produktu',
            sku_sklepu: 'SKU-TEST', cena_gr: 9900, miniatura: MINIATURA, zdjecia_json: JSON.stringify([ORYGINAL]), wzor_id: 7 });
        expect(druga.prepare('SELECT nazwa,sku FROM wzory WHERE id=7').get()).toEqual({ nazwa: 'Kotwica', sku: 'TEST-7' });
      } finally { druga.close(); }
    } finally { rmSync(katalog, { recursive: true, force: true }); }
  });

  // ⚠️ PARA: kolumna lustra przepisuje się przy każdym odczycie, ale POWIĄZANIE Z WZOREM ma
  // przeżyć. Gdyby `miniatura` ruszyła przy okazji `wzor_id`, każde odświeżenie katalogu
  // zrywałoby ręczną pracę właściciela — po cichu i bez jednego błędu.
  it('zapis miniatury nie zrywa powiązania z wzorem', () => {
    const db = openOmsDb(':memory:');
    db.prepare("INSERT INTO wzory (id, nazwa, utworzony_at, zmieniony_at) VALUES (7,'Kotwica','x','x')").run();
    const wiersz = {
      kanal: 'szkicownia', produkt_id: '7179', wariant_id: '', nazwa: 'Kotwica',
      odczytane_at: TERAZ, miniatura: MINIATURA,
    };
    const id = zapiszProduktSklepowy(db, wiersz);
    db.prepare('UPDATE produkty_sklepowe SET wzor_id = 7 WHERE id = ?').run(id);

    zapiszProduktSklepowy(db, { ...wiersz, miniatura: null });
    const po = db.prepare('SELECT wzor_id, miniatura FROM produkty_sklepowe WHERE id = ?').get(id);
    expect(po).toEqual({ wzor_id: 7, miniatura: null });
  });
});
