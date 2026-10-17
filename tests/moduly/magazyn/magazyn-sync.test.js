// Przebieg odczytu katalogow do lustra magazynu — spinacz czterech kanalow.
//
// ⚠️ NAJWAZNIEJSZY NIEZMIENNIK TEGO PLIKU: kanal, ktory PADL, NIE DOCHODZI do
// `oznaczZnikniete`. Oznaczyloby to CALY jego katalog jako znikniety ze sprzedazy —
// czyli dokladnie ta szkode, przed ktora broni cala konstrukcja lustra.
//
// ⚠️ Zadne wywolanie w tym pliku nie dotyka prawdziwego sklepu ani Allegro: klienci sa
// atrapami, a baza siedzi w pamieci.
import { describe, it, expect, vi } from 'vitest';
import { openOmsDb } from '../../../src/oms/db/db.ts';
import { odswiezMagazyn } from '../../../src/moduly/magazyn/services/magazyn-sync.js';

const TERAZ = '2026-08-06T10:00:00Z';
const teraz = (wartosc = TERAZ) => () => wartosc;

const sklepAtrapa = (produkty, warianty = {}) => ({
  pobierzWszystkieProdukty: vi.fn(async () => produkty),
  pobierzWarianty: vi.fn(async (id) => warianty[id] ?? []),
});

const allegroAtrapa = (oferty) => ({ pobierzOferty: vi.fn(async () => oferty) });

const oferta = (id, nazwa = `Oferta ${id}`) => ({
  id, name: nazwa,
  sellingMode: { price: { amount: '89.00', currency: 'PLN' } },
  publication: { status: 'ACTIVE' },
});

const prosty = (nadpisz = {}) => ({
  id: 900, type: 'simple', name: 'Kropla 70x100 cm', sku: 'LMP-KRO-1', price: '74.90',
  permalink: 'https://pro.sklep-polcien.example.invalid/produkt/kropla/',
  short_description: '<p>Lampa</p>',
  categories: [{ id: 12, name: 'Oświetlenie' }],
  images: [{ src: 'https://pro.sklep-polcien.example.invalid/a.jpg' }, { src: 'https://pro.sklep-polcien.example.invalid/b.jpg' }],
  ...nadpisz,
});

const wiersze = (db) => db.prepare('SELECT * FROM produkty_sklepowe ORDER BY kanal, produkt_id, wariant_id').all();
const jeden = (db) => wiersze(db)[0];
const kanal = (w, nazwa) => w.kanaly.find((k) => k.kanal === nazwa);

// ============================================================================
// KSZTALT LUSTRA
// ============================================================================

describe('odswiezMagazyn — kształt lustra', () => {
  it('produkt prosty daje jeden wiersz, wariantowy — po wierszu na wariant', async () => {
    const db = openOmsDb(':memory:');
    const sklepy = {
      pro: sklepAtrapa(
        [
          { id: 944, type: 'variable', name: 'Plafon', price: '49' },
          { id: 900, type: 'simple', name: 'Kropla 70x100 cm', sku: 'LMP-KRO-1', price: '74.90' },
        ],
        { 944: [{ id: 1090, sku: 'LMP-PLA-117', price: '49', attributes: [{ name: 'Rozmiar', option: '45 x 65 cm' }] }] },
      ),
    };
    const w = await odswiezMagazyn({ kanalySklepow: ['pro', 'szkicownia'], kanalyAllegro: ['allegro_szkicownia', 'allegro_amarka'],  db, sklepy, allegro: null, teraz: teraz() });
    expect(kanal(w, 'pro').zapisane).toBe(2);
    expect(db.prepare('SELECT produkt_id, wariant_id FROM produkty_sklepowe ORDER BY produkt_id').all())
      .toEqual([{ produkt_id: '900', wariant_id: '' }, { produkt_id: '944', wariant_id: '1090' }]);
  });

  // ⚠️ Rodzic produktu wariantowego NIE jest osobnym wierszem — jego SKU jest puste,
  // a cena to zakres. Wiersz = wariant (zmierzone: PRO ma 58 takich produktow na 104).
  it('rodzic produktu wariantowego nie wchodzi do lustra', async () => {
    const db = openOmsDb(':memory:');
    const sklepy = {
      pro: sklepAtrapa([{ id: 944, type: 'variable', name: 'Plafon' }],
        { 944: [{ id: 1090, sku: 'A', price: '49' }, { id: 1091, sku: 'B', price: '74.90' }] }),
    };
    await odswiezMagazyn({ kanalySklepow: ['pro', 'szkicownia'], kanalyAllegro: ['allegro_szkicownia', 'allegro_amarka'],  db, sklepy, allegro: null, teraz: teraz() });
    expect(db.prepare("SELECT COUNT(*) c FROM produkty_sklepowe WHERE wariant_id = ''").get().c).toBe(0);
    expect(wiersze(db).length).toBe(2);
  });

  // ⚠️ PARA DO TESTU WYZEJ: pobieranie wariantow ma MILCZEC przy produktach prostych.
  // Bez tego „pobierz warianty kazdego produktu" przechodziloby na zielono, a na produkcji
  // dokladaloby 668 zadan HTTP po nic — i wywracaloby odczyt na pierwszym sklepie,
  // ktory na `/products/{id}/variations` produktu prostego oddaje blad.
  it('warianty pobierane WYŁĄCZNIE dla produktów wariantowych', async () => {
    const db = openOmsDb(':memory:');
    const sklep = sklepAtrapa(
      [
        { id: 900, type: 'simple', name: 'A', price: '10' },
        { id: 944, type: 'variable', name: 'Plafon' },
        { id: 7, type: 'grouped', name: 'G', price: '20' },
      ],
      { 944: [{ id: 1090, sku: 'A', price: '49' }] },
    );
    await odswiezMagazyn({ kanalySklepow: ['pro', 'szkicownia'], kanalyAllegro: ['allegro_szkicownia', 'allegro_amarka'],  db, sklepy: { pro: sklep }, allegro: null, teraz: teraz() });
    expect(sklep.pobierzWarianty.mock.calls).toEqual([[944]]);
  });

  it('produkt wariantowy bez ani jednego wariantu nie zostawia po sobie wiersza', async () => {
    const db = openOmsDb(':memory:');
    const sklepy = { pro: sklepAtrapa([{ id: 944, type: 'variable', name: 'Plafon' }], { 944: [] }) };
    const w = await odswiezMagazyn({ kanalySklepow: ['pro', 'szkicownia'], kanalyAllegro: ['allegro_szkicownia', 'allegro_amarka'],  db, sklepy, allegro: null, teraz: teraz() });
    expect(wiersze(db)).toEqual([]);
    expect(kanal(w, 'pro').zapisane).toBe(0);
    expect(kanal(w, 'pro').blad).toBe(null);
  });

  // ⚠️ `produkt_id` i `wariant_id` MUSZA byc TEKSTEM, a Woo oddaje LICZBE. Liczba w kolumnie
  // TEXT to wiodace zera stracone po cichu i `RangeError` przy odczycie powyzej 2^53 —
  // czyli jeden wiersz przestaje renderowac CALA liste magazynu.
  it('identyfikatory z Woo lądują w bazie jako TEKST, nie liczba', async () => {
    const db = openOmsDb(':memory:');
    const sklepy = {
      pro: sklepAtrapa([{ id: 944, type: 'variable', name: 'Plafon' }],
        { 944: [{ id: 1090, sku: 'A', price: '49' }] }),
    };
    await odswiezMagazyn({ kanalySklepow: ['pro', 'szkicownia'], kanalyAllegro: ['allegro_szkicownia', 'allegro_amarka'],  db, sklepy, allegro: null, teraz: teraz() });
    const r = jeden(db);
    expect(typeof r.produkt_id).toBe('string');
    expect(typeof r.wariant_id).toBe('string');
    expect([r.produkt_id, r.wariant_id]).toEqual(['944', '1090']);
  });

  it('produkt prosty przepisuje wszystkie kolumny lustra', async () => {
    const db = openOmsDb(':memory:');
    await odswiezMagazyn({ kanalySklepow: ['pro', 'szkicownia'], kanalyAllegro: ['allegro_szkicownia', 'allegro_amarka'],  db, sklepy: { pro: sklepAtrapa([prosty()]) }, allegro: null, teraz: teraz() });
    expect(jeden(db)).toMatchObject({
      kanal: 'pro',
      produkt_id: '900',
      wariant_id: '',
      nazwa: 'Kropla 70x100 cm',
      sku_sklepu: 'LMP-KRO-1',
      cena_gr: 7490,
      kategorie_json: '["Oświetlenie"]',
      zdjecia_json: '["https://pro.sklep-polcien.example.invalid/a.jpg","https://pro.sklep-polcien.example.invalid/b.jpg"]',
      adres: 'https://pro.sklep-polcien.example.invalid/produkt/kropla/',
      opis_zrodlowy: '<p>Lampa</p>',
      // Sklepy pobieramy WYLACZNIE ze `status=publish`, wiec stanu publikacji nie ma
      // czym wypelnic — kolumna nalezy do Allegro (ACTIVE/ENDED).
      status_publikacji: null,
      zniknal_at: null,
    });
  });

  // ⚠️ SKU I CENA ZYJA NA WARIANCIE, a nazwa i kategorie tylko na rodzicu (zmierzone:
  // rodzic `Plafon` ma SKU puste i cene jako zakres 49–74,90). Wziecie ceny z rodzica
  // wpisaloby wszystkim wariantom te sama, nieprawdziwa kwote.
  it('wariant bierze SKU, cenę i adres z SIEBIE, a nazwę i kategorie z rodzica', async () => {
    const db = openOmsDb(':memory:');
    const rodzic = prosty({
      id: 944, type: 'variable', name: 'Plafon', sku: '', price: '49',
      categories: [{ id: 12, name: 'Oświetlenie' }, { id: 13, name: 'Na ściany' }],
    });
    const sklepy = {
      pro: sklepAtrapa([rodzic], {
        944: [{
          id: 1090, sku: 'LMP-PLA-117', price: '49.00',
          permalink: 'https://pro.sklep-polcien.example.invalid/produkt/plafon/?attribute_rozmiar=45',
          attributes: [{ name: 'Rozmiar', option: '45 x 65 cm' }],
        }],
      }),
    };
    await odswiezMagazyn({ kanalySklepow: ['pro', 'szkicownia'], kanalyAllegro: ['allegro_szkicownia', 'allegro_amarka'],  db, sklepy, allegro: null, teraz: teraz() });
    expect(jeden(db)).toMatchObject({
      nazwa: 'Plafon',
      sku_sklepu: 'LMP-PLA-117',
      cena_gr: 4900,
      adres: 'https://pro.sklep-polcien.example.invalid/produkt/plafon/?attribute_rozmiar=45',
      kategorie_json: '["Oświetlenie","Na ściany"]',
      opis_zrodlowy: '<p>Lampa</p>',
    });
  });

  it('wariant bez własnego adresu spada na adres rodzica', async () => {
    const db = openOmsDb(':memory:');
    const sklepy = {
      pro: sklepAtrapa([prosty({ id: 944, type: 'variable' })], { 944: [{ id: 1090, sku: 'A', price: '1' }] }),
    };
    await odswiezMagazyn({ kanalySklepow: ['pro', 'szkicownia'], kanalyAllegro: ['allegro_szkicownia', 'allegro_amarka'],  db, sklepy, allegro: null, teraz: teraz() });
    expect(jeden(db).adres).toBe('https://pro.sklep-polcien.example.invalid/produkt/kropla/');
  });

  // Zdjecia ida na karte produktu i na ekrany zamowien —
  // wlasne zdjecie wariantu jest najbardziej szczegolowe, wiec idzie PIERWSZE, ale
  // galeria rodzica nie ma prawa przez to zginac.
  it('wariant stawia własne zdjęcie przed galerią rodzica, bez powtórzeń', async () => {
    const db = openOmsDb(':memory:');
    const sklepy = {
      pro: sklepAtrapa([prosty({ id: 944, type: 'variable' })], {
        944: [{ id: 1090, sku: 'A', price: '1', image: { src: 'https://pro.sklep-polcien.example.invalid/b.jpg' } }],
      }),
    };
    await odswiezMagazyn({ kanalySklepow: ['pro', 'szkicownia'], kanalyAllegro: ['allegro_szkicownia', 'allegro_amarka'],  db, sklepy, allegro: null, teraz: teraz() });
    expect(JSON.parse(jeden(db).zdjecia_json))
      .toEqual(['https://pro.sklep-polcien.example.invalid/b.jpg', 'https://pro.sklep-polcien.example.invalid/a.jpg']);
  });

  it('produkt bez zdjęć daje null, a nie pustą tablicę', async () => {
    const db = openOmsDb(':memory:');
    await odswiezMagazyn({ kanalySklepow: ['pro', 'szkicownia'], kanalyAllegro: ['allegro_szkicownia', 'allegro_amarka'],  db, sklepy: { pro: sklepAtrapa([prosty({ images: [] })]) }, allegro: null, teraz: teraz() });
    expect(jeden(db).zdjecia_json).toBe(null);
  });

  // ⚠️ Wariant bez identyfikatora zapisalby sie z `wariant_id = ''`, czyli PODSZYLBY SIE pod
  // wiersz produktu prostego o tym samym `produkt_id` — a przy dwoch takich wariantach kazdy
  // przebieg nadpisywalby ten jeden wiersz kolejnym rodzenstwem, po cichu i na okraglo.
  it('wariant bez identyfikatora wywala kanał, zamiast podszyć się pod produkt prosty', async () => {
    const db = openOmsDb(':memory:');
    const sklepy = {
      pro: sklepAtrapa([prosty({ id: 944, type: 'variable' })], {
        944: [{ sku: 'A', price: '1' }, { sku: 'B', price: '2' }],
      }),
    };
    const w = await odswiezMagazyn({ kanalySklepow: ['pro', 'szkicownia'], kanalyAllegro: ['allegro_szkicownia', 'allegro_amarka'],  db, sklepy, allegro: null, teraz: teraz() });
    expect(kanal(w, 'pro').blad).toMatch(/identyfikator/i);
    expect(kanal(w, 'pro').blad).toMatch(/944/);
    expect(wiersze(db)).toEqual([]);
  });

  // Kolumna `nazwa` jest NOT NULL, a bez niej wiersza nie da sie z niczym powiazac
  // recznie. Bez tego straznika brak nazwy wychodzi dopiero na bazie, w polowie 668 produktow.
  it('produkt bez nazwy wywala kanał z komunikatem, który go nazywa', async () => {
    const db = openOmsDb(':memory:');
    const sklepy = { pro: sklepAtrapa([{ id: 900, type: 'simple', price: '10' }]) };
    const w = await odswiezMagazyn({ kanalySklepow: ['pro', 'szkicownia'], kanalyAllegro: ['allegro_szkicownia', 'allegro_amarka'],  db, sklepy, allegro: null, teraz: teraz() });
    expect(kanal(w, 'pro').blad).toMatch(/nazw/i);
    expect(kanal(w, 'pro').blad).toMatch(/900/);
    expect(wiersze(db)).toEqual([]);
  });
});

// ============================================================================
// ROZMIAR
// ============================================================================

describe('odswiezMagazyn — rozmiar', () => {
  it('rozmiar produktu prostego bierze się z nazwy', async () => {
    const db = openOmsDb(':memory:');
    const sklepy = { pro: sklepAtrapa([{ id: 900, type: 'simple', name: 'Kropla – 60x62cm', price: '10' }]) };
    await odswiezMagazyn({ kanalySklepow: ['pro', 'szkicownia'], kanalyAllegro: ['allegro_szkicownia', 'allegro_amarka'],  db, sklepy, allegro: null, teraz: teraz() });
    expect(jeden(db).rozmiar_tekst).toBe('Kropla – 60x62cm');
  });

  it('rozmiar wariantu bierze się z atrybutu „Rozmiar"', async () => {
    const db = openOmsDb(':memory:');
    const sklepy = {
      pro: sklepAtrapa([{ id: 944, type: 'variable', name: 'Plafon' }], {
        944: [{ id: 1090, sku: 'A', price: '1', attributes: [{ name: 'Rozmiar', option: '45 x 65 cm' }] }],
      }),
    };
    await odswiezMagazyn({ kanalySklepow: ['pro', 'szkicownia'], kanalyAllegro: ['allegro_szkicownia', 'allegro_amarka'],  db, sklepy, allegro: null, teraz: teraz() });
    expect(jeden(db).rozmiar_tekst).toBe('45 x 65 cm');
  });

  // ⚠️ ATRYBUT WYGRYWA NAD NAZWA I TO JEST REGULA NOSNA, NIE PORZADKOWA. Na PRO oba niosa
  // ROZNE, PRAWDZIWE liczby: „Klosz dymny – 60x62cm" ma atrybut „70 x 100 cm", bo
  // 60×62 to wymiar z tytulu sprzedazowego, a 70×100 to wymiar produktu, ktory sklep wysyla.
  // Magazyn trzyma wymiar PRODUKTU — to on decyduje o pakowaniu, paczkomacie i cenie.
  it('atrybut wygrywa nad nazwą, bo nazwa niesie tytuł sprzedażowy, a atrybut wymiar produktu', async () => {
    const db = openOmsDb(':memory:');
    const sklepy = {
      pro: sklepAtrapa([{ id: 944, type: 'variable', name: 'Klosz dymny – 60x62cm' }], {
        944: [{ id: 1090, sku: 'A', price: '1', attributes: [{ name: 'Rozmiar', option: '70 x 100 cm' }] }],
      }),
    };
    await odswiezMagazyn({ kanalySklepow: ['pro', 'szkicownia'], kanalyAllegro: ['allegro_szkicownia', 'allegro_amarka'],  db, sklepy, allegro: null, teraz: teraz() });
    expect(jeden(db).rozmiar_tekst).toBe('70 x 100 cm');
  });

  // ⚠️⚠️ SZESC PRODUKTOW WARIANTOWYCH W SKLEPIE A JEST ZEPSUTYCH: warianty
  // roznia sie WYLACZNIE cena (79/99/119 zl) i nie niosa ZADNEGO atrybutu rozmiaru.
  // Podstawienie tam nazwy rodzica daloby TRZEM roznym rozmiarom ten sam wymiar — a to
  // ten wymiar idzie do sklepu, na etykiete i do wyliczenia gabarytu. Brak jest tu
  // JEDYNA uczciwa odpowiedzia (Zadanie 8 pomija takie warianty po `rozmiar_tekst`).
  it('wariant BEZ atrybutu rozmiaru nie pożycza nazwy rodzica — zostaje pusty', async () => {
    const db = openOmsDb(':memory:');
    const sklepy = {
      pro: sklepAtrapa([{ id: 944, type: 'variable', name: 'Kolekcja Las 70x100 cm' }], {
        944: [
          { id: 1, sku: 'A', price: '79' },
          { id: 2, sku: 'B', price: '99', attributes: [{ name: 'Motyw', option: 'Sowa' }] },
        ],
      }),
    };
    await odswiezMagazyn({ kanalySklepow: ['pro', 'szkicownia'], kanalyAllegro: ['allegro_szkicownia', 'allegro_amarka'],  db, sklepy, allegro: null, teraz: teraz() });
    expect(wiersze(db).map((r) => r.rozmiar_tekst)).toEqual([null, null]);
  });

  it('produkt prosty z atrybutem „Rozmiar" bierze atrybut, nie nazwę', async () => {
    const db = openOmsDb(':memory:');
    const sklepy = {
      pro: sklepAtrapa([prosty({ name: 'Kropla – 60x62cm', attributes: [{ name: 'Rozmiar', options: ['70 x 100 cm'] }] })]),
    };
    await odswiezMagazyn({ kanalySklepow: ['pro', 'szkicownia'], kanalyAllegro: ['allegro_szkicownia', 'allegro_amarka'],  db, sklepy, allegro: null, teraz: teraz() });
    expect(jeden(db).rozmiar_tekst).toBe('70 x 100 cm');
  });

  // Atrybut o innej nazwie nie jest rozmiarem — i nie ma prawa nim zostac „bo byl jedyny".
  it('atrybut, który nie jest rozmiarem, nie przesłania nazwy', async () => {
    const db = openOmsDb(':memory:');
    const sklepy = {
      pro: sklepAtrapa([prosty({ name: 'Kropla – 60x62cm', attributes: [{ name: 'Kolor', options: ['czarny'] }] })]),
    };
    await odswiezMagazyn({ kanalySklepow: ['pro', 'szkicownia'], kanalyAllegro: ['allegro_szkicownia', 'allegro_amarka'],  db, sklepy, allegro: null, teraz: teraz() });
    expect(jeden(db).rozmiar_tekst).toBe('Kropla – 60x62cm');
  });
});

// ============================================================================
// KATEGORIA GLOWNA (Yoast)
// ============================================================================

describe('odswiezMagazyn — kategoria główna ze sklepu', () => {
  // ⚠️ Yoast trzyma IDENTYFIKATOR terminu jako NAPIS. Nazwa jest w kategoriach TEGO SAMEGO
  // produktu, wiec mapowanie nie kosztuje ani jednego dodatkowego zadania.
  it('mapuje identyfikator z Yoasta na nazwę kategorii produktu', async () => {
    const db = openOmsDb(':memory:');
    const p = prosty({
      categories: [{ id: 12, name: 'Boho' }, { id: 64, name: 'Modern Organic' }],
      meta_data: [{ key: '_yoast_wpseo_primary_product_cat', value: '64' }],
    });
    await odswiezMagazyn({ kanalySklepow: ['pro', 'szkicownia'], kanalyAllegro: ['allegro_szkicownia', 'allegro_amarka'],  db, sklepy: { pro: sklepAtrapa([p]) }, allegro: null, teraz: teraz() });
    expect(jeden(db).kategoria_glowna_zrodla).toBe('Modern Organic');
  });

  // ⚠️ SUROWY IDENTYFIKATOR W KOLUMNIE NAZWY jest gorszy niz brak: Zadanie 8 przepisuje
  // te wartosc do `karty.kategoria_glowna`, a z niej korzysta generator SKU.
  it('identyfikator spoza kategorii produktu daje brak, a nie surowy numer', async () => {
    const db = openOmsDb(':memory:');
    const p = prosty({
      categories: [{ id: 12, name: 'Boho' }],
      meta_data: [{ key: '_yoast_wpseo_primary_product_cat', value: '64' }],
    });
    await odswiezMagazyn({ kanalySklepow: ['pro', 'szkicownia'], kanalyAllegro: ['allegro_szkicownia', 'allegro_amarka'],  db, sklepy: { pro: sklepAtrapa([p]) }, allegro: null, teraz: teraz() });
    expect(jeden(db).kategoria_glowna_zrodla).toBe(null);
  });

  it('brak metadanej Yoasta daje brak, a nie pierwszą kategorię z brzegu', async () => {
    const db = openOmsDb(':memory:');
    const p = prosty({ categories: [{ id: 12, name: 'Boho' }, { id: 13, name: 'Farmhouse' }], meta_data: [] });
    await odswiezMagazyn({ kanalySklepow: ['pro', 'szkicownia'], kanalyAllegro: ['allegro_szkicownia', 'allegro_amarka'],  db, sklepy: { pro: sklepAtrapa([p]) }, allegro: null, teraz: teraz() });
    expect(jeden(db).kategoria_glowna_zrodla).toBe(null);
  });

  it('wariant dziedziczy kategorię główną rodzica', async () => {
    const db = openOmsDb(':memory:');
    const rodzic = prosty({
      id: 944, type: 'variable',
      categories: [{ id: 64, name: 'Modern Organic' }],
      meta_data: [{ key: '_yoast_wpseo_primary_product_cat', value: '64' }],
    });
    const sklepy = { pro: sklepAtrapa([rodzic], { 944: [{ id: 1090, sku: 'A', price: '1' }] }) };
    await odswiezMagazyn({ kanalySklepow: ['pro', 'szkicownia'], kanalyAllegro: ['allegro_szkicownia', 'allegro_amarka'],  db, sklepy, allegro: null, teraz: teraz() });
    expect(jeden(db).kategoria_glowna_zrodla).toBe('Modern Organic');
  });
});

// ============================================================================
// CENA
// ============================================================================

describe('odswiezMagazyn — cena ze sklepu', () => {
  // ⚠️ Woo oddaje cene NAPISEM, a kolumna `cena_gr` jest `INTEGER`. Napis w niej psuje filtr
  // ceny w CALYM magazynie: porownanie napisu z liczba w SQLite jest zawsze falszywe.
  it('cena napisem ląduje w bazie jako liczba groszy', async () => {
    const db = openOmsDb(':memory:');
    const sklepy = {
      pro: sklepAtrapa([
        prosty({ id: 1, price: '74.90' }), prosty({ id: 2, price: '49' }), prosty({ id: 3, price: '28.9' }),
      ]),
    };
    await odswiezMagazyn({ kanalySklepow: ['pro', 'szkicownia'], kanalyAllegro: ['allegro_szkicownia', 'allegro_amarka'],  db, sklepy, allegro: null, teraz: teraz() });
    const ceny = wiersze(db).map((r) => r.cena_gr);
    expect(ceny).toEqual([7490, 4900, 2890]);
    expect(ceny.every((c) => Number.isInteger(c))).toBe(true);
  });

  it('produkt bez ceny daje null, a nie zero', async () => {
    const db = openOmsDb(':memory:');
    const sklepy = {
      pro: sklepAtrapa([prosty({ id: 1, price: '' }), prosty({ id: 2, price: null }), prosty({ id: 3, price: '  ' })]),
    };
    await odswiezMagazyn({ kanalySklepow: ['pro', 'szkicownia'], kanalyAllegro: ['allegro_szkicownia', 'allegro_amarka'],  db, sklepy, allegro: null, teraz: teraz() });
    expect(wiersze(db).map((r) => r.cena_gr)).toEqual([null, null, null]);
  });

  // ⚠️ Kwota tak duza, ze przestaje byc DOKLADNA, jest bledem, a nie zaokragleniem: powyzej
  // 2^53 grosz przestaje istniec, a wynik i tak wpadlby do kolumny pieniedzy. Straznik
  // `Number.isSafeInteger` byl do tej pory w calej suicie nieprzypiety — zlapala to dopiero
  // weryfikacja mutacyjna Zadania 7 (mutacja E1 przezyla).
  it('kwota poza zakresem dokładnych liczb całkowitych wywala kanał', async () => {
    const db = openOmsDb(':memory:');
    const sklepy = { pro: sklepAtrapa([prosty({ id: 900, price: '99999999999999999999.99' })]) };
    const w = await odswiezMagazyn({ kanalySklepow: ['pro', 'szkicownia'], kanalyAllegro: ['allegro_szkicownia', 'allegro_amarka'],  db, sklepy, allegro: null, teraz: teraz() });
    expect(kanal(w, 'pro').blad).toMatch(/kwot/i);
    expect(wiersze(db)).toEqual([]);
  });

  // ⚠️ PARA: straznik ma byc GLOSNY na kwocie, ktorej nie umie przeliczyc — i ma przy tym
  // NIE oznaczyc niczego jako znikniete (kanal padl, wiec jego katalog nie jest wycofany).
  it('cena nie do przeliczenia wywala kanał i nie zapisuje niczego', async () => {
    const db = openOmsDb(':memory:');
    const sklepy = { pro: sklepAtrapa([prosty({ id: 900, price: '74,90' })]) };
    const w = await odswiezMagazyn({ kanalySklepow: ['pro', 'szkicownia'], kanalyAllegro: ['allegro_szkicownia', 'allegro_amarka'],  db, sklepy, allegro: null, teraz: teraz() });
    expect(kanal(w, 'pro').blad).toMatch(/74,90/);
    expect(kanal(w, 'pro').blad).toMatch(/900/);
    expect(wiersze(db)).toEqual([]);
  });
});

// ============================================================================
// ALLEGRO
// ============================================================================

describe('odswiezMagazyn — kanały Allegro', () => {
  // ⚠️ `pobierzOferty()` JEST BEZ ARGUMENTU. Klient jest juz per-konto (bootstrap.js,
  // `klienciKanalow`); kanal dokleja WOLAJACY, z klucza mapy.
  it('woła pobierzOferty BEZ argumentu i dokleja kanał z klucza mapy', async () => {
    const db = openOmsDb(':memory:');
    const klient = allegroAtrapa([oferta('1234567890', 'Trójnóg podłogowy')]);
    const w = await odswiezMagazyn({ kanalySklepow: ['pro', 'szkicownia'], kanalyAllegro: ['allegro_szkicownia', 'allegro_amarka'],  db, sklepy: null, allegro: { allegro_amarka: klient }, teraz: teraz() });
    expect(klient.pobierzOferty.mock.calls.length).toBe(1);
    // Asercja po WSZYSTKICH wywolaniach, nie po [0].
    expect(klient.pobierzOferty.mock.calls.every((a) => a.length === 0)).toBe(true);
    expect(kanal(w, 'allegro_amarka').zapisane).toBe(1);
    expect(jeden(db)).toMatchObject({
      kanal: 'allegro_amarka',
      produkt_id: '1234567890',
      wariant_id: '',
      nazwa: 'Trójnóg podłogowy',
      cena_gr: 8900,
      status_publikacji: 'ACTIVE',
      adres: 'https://allegro.pl/oferta/1234567890',
    });
  });

  // ⚠️⚠️ KAZDY KLIENT WOLANY DOKLADNIE RAZ. Druga instancja klienta na ten sam kanal to druga
  // para tokenow i DWA niezalezne odswiezenia tego samego, JEDNORAZOWEGO refresh tokenu —
  // spalenie go rozwala pollera zamowien i nadawanie paczek, oba na produkcji.
  it('każdy klient Allegro wołany dokładnie raz, żaden kanał nie czyta cudzego katalogu', async () => {
    const db = openOmsDb(':memory:');
    const a = allegroAtrapa([oferta('1')]);
    const b = allegroAtrapa([oferta('2')]);
    const w = await odswiezMagazyn({ kanalySklepow: ['pro', 'szkicownia'], kanalyAllegro: ['allegro_szkicownia', 'allegro_amarka'], 
      db, sklepy: null, allegro: { allegro_szkicownia: a, allegro_amarka: b }, teraz: teraz(),
    });
    expect(a.pobierzOferty.mock.calls.length).toBe(1);
    expect(b.pobierzOferty.mock.calls.length).toBe(1);
    expect(w.kanaly.map((k) => [k.kanal, k.zapisane]))
      .toEqual([['allegro_szkicownia', 1], ['allegro_amarka', 1]]);
    expect(wiersze(db).map((r) => [r.kanal, r.produkt_id]))
      .toEqual([['allegro_amarka', '2'], ['allegro_szkicownia', '1']]);
  });

  it('brak kanałów Allegro nie przeszkadza sklepom', async () => {
    for (const allegro of [null, undefined, {}]) {
      const db = openOmsDb(':memory:');
      const w = await odswiezMagazyn({ kanalySklepow: ['pro', 'szkicownia'], kanalyAllegro: ['allegro_szkicownia', 'allegro_amarka'],  db, sklepy: { pro: sklepAtrapa([prosty()]) }, allegro, teraz: teraz() });
      expect(w.kanaly.map((k) => k.kanal)).toEqual(['pro']);
      expect(kanal(w, 'pro').zapisane).toBe(1);
    }
  });

  it('brak sklepów nie przeszkadza kanałom Allegro', async () => {
    const db = openOmsDb(':memory:');
    const w = await odswiezMagazyn({ kanalySklepow: ['pro', 'szkicownia'], kanalyAllegro: ['allegro_szkicownia', 'allegro_amarka'], 
      db, sklepy: undefined, allegro: { allegro_szkicownia: allegroAtrapa([oferta('1')]) }, teraz: teraz(),
    });
    expect(w.kanaly.map((k) => k.kanal)).toEqual(['allegro_szkicownia']);
  });

  // Oferta, ktorej `ofertaNaProdukt` nie przyjmuje (cena w EUR, brak nazwy), wywala SWOJ
  // kanal — i tak samo jak przy sklepie nie ma prawa niczego oznaczyc jako znikniete.
  it('oferta odrzucona przez regułę wywala swój kanał, a nie cały przebieg', async () => {
    const db = openOmsDb(':memory:');
    const zly = allegroAtrapa([{ id: '1', name: 'X', sellingMode: { price: { amount: '89.00', currency: 'EUR' } } }]);
    const w = await odswiezMagazyn({ kanalySklepow: ['pro', 'szkicownia'], kanalyAllegro: ['allegro_szkicownia', 'allegro_amarka'], 
      db,
      sklepy: { pro: sklepAtrapa([prosty()]) },
      allegro: { allegro_szkicownia: zly },
      teraz: teraz(),
    });
    expect(kanal(w, 'allegro_szkicownia').blad).toMatch(/EUR/);
    expect(kanal(w, 'pro').zapisane).toBe(1);
    expect(kanal(w, 'pro').blad).toBe(null);
  });
});

// ============================================================================
// BIALA LISTA KANALOW
// ============================================================================

describe('odswiezMagazyn — biała lista kanałów', () => {
  // ⚠️ `zapiszProduktSklepowy` sprawdza tylko, czy kanal jest NIEPUSTY. Literowka zalozylaby
  // kanal WIDMOWY: wiersze, ktorych nie pokaze zaden filtr listy, a ktorych `oznaczZnikniete`
  // nigdy nie posprzata.
  it('sklep pod nieznanym kluczem daje błąd i ani jednego wiersza', async () => {
    const db = openOmsDb(':memory:');
    const zly = sklepAtrapa([prosty()]);
    const w = await odswiezMagazyn({ kanalySklepow: ['pro', 'szkicownia'], kanalyAllegro: ['allegro_szkicownia', 'allegro_amarka'], 
      db, sklepy: { prod: zly, szkicownia: sklepAtrapa([prosty({ id: 5 })]) }, allegro: null, teraz: teraz(),
    });
    expect(kanal(w, 'prod').blad).toMatch(/prod/);
    expect(kanal(w, 'szkicownia').zapisane).toBe(1);
    expect(wiersze(db).map((r) => r.kanal)).toEqual(['szkicownia']);
    // Kanal odrzucony nie ma prawa nawet ZAPYTAC sklepu.
    expect(zly.pobierzWszystkieProdukty.mock.calls.length).toBe(0);
  });

  // Sklep podpiety pod klucz Allegro wpisalby produkty Woo do katalogu Allegro — i przy
  // najblizszym przebiegu kanalu Allegro caly ten katalog zostalby oznaczony jako znikniety.
  it('sklep pod kluczem kanału Allegro jest odrzucany', async () => {
    const db = openOmsDb(':memory:');
    const w = await odswiezMagazyn({ kanalySklepow: ['pro', 'szkicownia'], kanalyAllegro: ['allegro_szkicownia', 'allegro_amarka'], 
      db, sklepy: { allegro_szkicownia: sklepAtrapa([prosty()]) }, allegro: null, teraz: teraz(),
    });
    expect(kanal(w, 'allegro_szkicownia').blad).toMatch(/allegro_szkicownia/);
    expect(wiersze(db)).toEqual([]);
  });

  it('kanał Allegro pod kluczem spoza białej listy jest odrzucany', async () => {
    const db = openOmsDb(':memory:');
    const klient = allegroAtrapa([oferta('1')]);
    const w = await odswiezMagazyn({ kanalySklepow: ['pro', 'szkicownia'], kanalyAllegro: ['allegro_szkicownia', 'allegro_amarka'],  db, sklepy: null, allegro: { allegro_stencil: klient, pro: klient }, teraz: teraz() });
    expect(kanal(w, 'allegro_stencil').blad).toMatch(/allegro_stencil/);
    expect(kanal(w, 'pro').blad).toMatch(/pro/);
    expect(klient.pobierzOferty.mock.calls.length).toBe(0);
    expect(wiersze(db)).toEqual([]);
  });

  // ⚠️ PARA DO TRZECH TESTOW WYZEJ: biala lista ma MILCZEC na czterech prawdziwych kanalach.
  // Bez tego przypadku straznik zaostrzony do „odrzucaj wszystko" przechodzilby na zielono,
  // a odczyt magazynu nie zapisywalby NICZEGO.
  it('cztery prawdziwe kanały przechodzą bez jednego błędu', async () => {
    const db = openOmsDb(':memory:');
    const w = await odswiezMagazyn({ kanalySklepow: ['pro', 'szkicownia'], kanalyAllegro: ['allegro_szkicownia', 'allegro_amarka'], 
      db,
      sklepy: { pro: sklepAtrapa([prosty({ id: 1 })]), szkicownia: sklepAtrapa([prosty({ id: 2 })]) },
      allegro: { allegro_szkicownia: allegroAtrapa([oferta('3')]), allegro_amarka: allegroAtrapa([oferta('4')]) },
      teraz: teraz(),
    });
    expect(w.kanaly.map((k) => k.kanal))
      .toEqual(['pro', 'szkicownia', 'allegro_szkicownia', 'allegro_amarka']);
    expect(w.kanaly.filter((k) => k.blad)).toEqual([]);
    expect(w.kanaly.map((k) => k.zapisane)).toEqual([1, 1, 1, 1]);
    expect(wiersze(db).length).toBe(4);
  });
});

// ============================================================================
// IZOLACJA AWARII — NAJWAZNIEJSZY NIEZMIENNIK ZADANIA
// ============================================================================

describe('odswiezMagazyn — awaria kanału', () => {
  it('awaria jednego kanału nie przerywa pozostałych', async () => {
    const db = openOmsDb(':memory:');
    const sklepy = {
      pro: { pobierzWszystkieProdukty: async () => { throw new Error('sklep leży'); } },
      szkicownia: sklepAtrapa([{ id: 5, type: 'simple', name: 'Plecionka', price: '99' }]),
    };
    const w = await odswiezMagazyn({ kanalySklepow: ['pro', 'szkicownia'], kanalyAllegro: ['allegro_szkicownia', 'allegro_amarka'], 
      db, sklepy, allegro: { allegro_szkicownia: allegroAtrapa([oferta('7')]) }, teraz: teraz(),
    });
    expect(kanal(w, 'pro').blad).toMatch(/sklep leży/);
    expect(kanal(w, 'szkicownia').zapisane).toBe(1);
    expect(kanal(w, 'allegro_szkicownia').zapisane).toBe(1);
  });

  it('awaria kanału Allegro nie przerywa sklepów ani drugiego konta', async () => {
    const db = openOmsDb(':memory:');
    const w = await odswiezMagazyn({ kanalySklepow: ['pro', 'szkicownia'], kanalyAllegro: ['allegro_szkicownia', 'allegro_amarka'], 
      db,
      sklepy: { pro: sklepAtrapa([prosty()]) },
      allegro: {
        allegro_szkicownia: { pobierzOferty: async () => { throw new Error('Allegro: HTTP 401 przy /sale/offers'); } },
        allegro_amarka: allegroAtrapa([oferta('9')]),
      },
      teraz: teraz(),
    });
    expect(kanal(w, 'allegro_szkicownia').blad).toMatch(/401/);
    expect(kanal(w, 'allegro_amarka').zapisane).toBe(1);
    expect(kanal(w, 'pro').zapisane).toBe(1);
  });

  // ⚠️⚠️ SEDNO ZADANIA. Bez tego nieudany przebieg oznaczylby CALY katalog sklepu jako
  // znikniety, a lista pokazalaby tysiac wycofanych produktow przy sprawnym sklepie.
  it('kanał, który padł, NIE dostaje oznaczenia zniknięcia', async () => {
    const db = openOmsDb(':memory:');
    const dobry = { pro: sklepAtrapa([{ id: 1, type: 'simple', name: 'A', price: '10' }]) };
    await odswiezMagazyn({ kanalySklepow: ['pro', 'szkicownia'], kanalyAllegro: ['allegro_szkicownia', 'allegro_amarka'],  db, sklepy: dobry, allegro: null, teraz: teraz('2026-08-06T10:00:00Z') });
    const zly = { pro: { pobierzWszystkieProdukty: async () => { throw new Error('padło'); } } };
    const w = await odswiezMagazyn({ kanalySklepow: ['pro', 'szkicownia'], kanalyAllegro: ['allegro_szkicownia', 'allegro_amarka'],  db, sklepy: zly, allegro: null, teraz: teraz('2026-08-07T10:00:00Z') });
    expect(db.prepare('SELECT zniknal_at FROM produkty_sklepowe').get().zniknal_at).toBe(null);
    expect(kanal(w, 'pro').znikniete).toBe(0);
  });

  // Ta sama zasada, gdy kanal pada W POLOWIE — na wariantach drugiego produktu. Wtedy czesc
  // katalogu zostala juz odczytana, wiec kuszace jest „zapisz, co masz". Nie wolno: brakujaca
  // reszta ma odczytane_at ze starego przebiegu i nastepny UDANY przebieg widzialby ja jak
  // zawsze — ale ten sam przebieg mogl juz oznaczyc ja jako znikniete.
  it('kanał, który padł w połowie, nie zostawia w bazie ani połowy katalogu', async () => {
    const db = openOmsDb(':memory:');
    const sklep = {
      pobierzWszystkieProdukty: async () => ([
        { id: 1, type: 'simple', name: 'A', price: '10' },
        { id: 2, type: 'variable', name: 'B' },
      ]),
      pobierzWarianty: async () => { throw new Error('Odczyt wariantów urwał się'); },
    };
    const w = await odswiezMagazyn({ kanalySklepow: ['pro', 'szkicownia'], kanalyAllegro: ['allegro_szkicownia', 'allegro_amarka'],  db, sklepy: { pro: sklep }, allegro: null, teraz: teraz() });
    expect(kanal(w, 'pro').blad).toMatch(/urwał/);
    expect(kanal(w, 'pro').zapisane).toBe(0);
    expect(wiersze(db)).toEqual([]);
  });

  // ⚠️ TO SAMO PRZY AWARII W FAZIE ZAPISU, nie odczytu — dlatego zapis kanalu idzie w JEDNEJ
  // transakcji. Bez niej pierwszy produkt zostaje w bazie z NOWYM `odczytane_at`, a reszta
  // katalogu ze starym: nastepny przebieg widzi wtedy lustro rozjechane w czasie, a licznik
  // znikniec przestaje cokolwiek znaczyc.
  it('awaria w połowie ZAPISU cofa cały zapis kanału', async () => {
    const db = openOmsDb(':memory:');
    const sklepy = {
      pro: sklepAtrapa([
        { id: 1, type: 'simple', name: 'A', price: '10' },
        { type: 'simple', name: 'B bez identyfikatora', price: '10' },
      ]),
    };
    const w = await odswiezMagazyn({ kanalySklepow: ['pro', 'szkicownia'], kanalyAllegro: ['allegro_szkicownia', 'allegro_amarka'],  db, sklepy, allegro: null, teraz: teraz() });
    expect(kanal(w, 'pro').blad).toMatch(/produkt_id/);
    expect(wiersze(db)).toEqual([]);
  });

  // ⚠️ Kontrola kompletnosci odczytu (Woo i Allegro) potrafi wywalac KAZDY przebieg tego
  // sklepu na stale — wtyczka widocznosci/B2B odsiewa pozycje PO policzeniu X-WP-Total.
  // Taki kanal ma zostac zamrozony w ostatnim znanym stanie, a nie wygaszony.
  it('kanał odrzucony przez kontrolę kompletności zostawia lustro nietknięte', async () => {
    const db = openOmsDb(':memory:');
    await odswiezMagazyn({ kanalySklepow: ['pro', 'szkicownia'], kanalyAllegro: ['allegro_szkicownia', 'allegro_amarka'], 
      db,
      sklepy: { szkicownia: sklepAtrapa([prosty({ id: 5 }), prosty({ id: 6 })]) },
      allegro: null,
      teraz: teraz('2026-08-06T10:00:00Z'),
    });
    const sklep = {
      pobierzWszystkieProdukty: async () => {
        throw new Error('Odczyt produktów urwał się: sklep zapowiedział 668 pozycji, a zebraliśmy 640.');
      },
    };
    const w = await odswiezMagazyn({ kanalySklepow: ['pro', 'szkicownia'], kanalyAllegro: ['allegro_szkicownia', 'allegro_amarka'],  db, sklepy: { szkicownia: sklep }, allegro: null, teraz: teraz('2026-08-07T10:00:00Z') });
    expect(kanal(w, 'szkicownia').blad).toMatch(/668/);
    expect(db.prepare('SELECT COUNT(*) c FROM produkty_sklepowe WHERE zniknal_at IS NOT NULL').get().c).toBe(0);
    expect(db.prepare("SELECT COUNT(*) c FROM produkty_sklepowe WHERE odczytane_at LIKE '2026-08-06%'").get().c).toBe(2);
  });

  // Awaria kanalu nie ma prawa przerwac PETLI — kanaly stojace ZA nim w kolejnosci musza
  // sie odczytac. Mutacja „rzuc dalej po pierwszym bledzie" zabija dokladnie to.
  it('nawet gdy padają trzy kanały, czwarty zapisuje się normalnie', async () => {
    const db = openOmsDb(':memory:');
    const pada = (co) => ({ pobierzWszystkieProdukty: async () => { throw new Error(co); } });
    const w = await odswiezMagazyn({ kanalySklepow: ['pro', 'szkicownia'], kanalyAllegro: ['allegro_szkicownia', 'allegro_amarka'], 
      db,
      sklepy: { pro: pada('raz'), szkicownia: sklepAtrapa([prosty({ id: 5 })]) },
      allegro: {
        allegro_szkicownia: { pobierzOferty: async () => { throw new Error('dwa'); } },
        allegro_amarka: { pobierzOferty: async () => { throw new Error('trzy'); } },
      },
      teraz: teraz(),
    });
    expect(w.kanaly.map((k) => k.blad)).toEqual(['raz', null, 'dwa', 'trzy']);
    expect(kanal(w, 'szkicownia').zapisane).toBe(1);
    expect(wiersze(db).length).toBe(1);
  });

  // Blad bez `message` (rzucony napis, `null`) ma dac czytelny slad, a nie „undefined"
  // w kolumnie bledu na ekranie.
  it('kanał, który rzucił czymś, co nie jest błędem, i tak opisuje się czytelnie', async () => {
    const db = openOmsDb(':memory:');
    const sklepy = { pro: { pobierzWszystkieProdukty: async () => { throw 'padło'; } } };
    const w = await odswiezMagazyn({ kanalySklepow: ['pro', 'szkicownia'], kanalyAllegro: ['allegro_szkicownia', 'allegro_amarka'],  db, sklepy, allegro: null, teraz: teraz() });
    expect(kanal(w, 'pro').blad).toMatch(/padło/);
  });
});

// ============================================================================
// ZNIKNIECIA I KOLEJNOSC OPERACJI
// ============================================================================

describe('odswiezMagazyn — zniknięcia', () => {
  it('produkt, którego sklep już nie pokazuje, dostaje zniknal_at i wraca w liczniku', async () => {
    const db = openOmsDb(':memory:');
    const sklepy = { pro: sklepAtrapa([prosty({ id: 1 }), prosty({ id: 2 })]) };
    await odswiezMagazyn({ kanalySklepow: ['pro', 'szkicownia'], kanalyAllegro: ['allegro_szkicownia', 'allegro_amarka'],  db, sklepy, allegro: null, teraz: teraz('2026-08-06T10:00:00Z') });
    const w = await odswiezMagazyn({ kanalySklepow: ['pro', 'szkicownia'], kanalyAllegro: ['allegro_szkicownia', 'allegro_amarka'], 
      db, sklepy: { pro: sklepAtrapa([prosty({ id: 1 })]) }, allegro: null, teraz: teraz('2026-08-07T10:00:00Z'),
    });
    expect(kanal(w, 'pro').znikniete).toBe(1);
    expect(db.prepare('SELECT produkt_id FROM produkty_sklepowe WHERE zniknal_at IS NOT NULL').all())
      .toEqual([{ produkt_id: '2' }]);
  });

  // ⚠️ `oznaczZnikniete` MUSI stac PO wszystkich zapisach kanalu. Przeniesione PRZED nie
  // zmienia stanu koncowego (upsert czysci `zniknal_at`), ale LICZNIK zaczyna mowic
  // „zniknelo 668 produktow" przy sklepie, w ktorym nie zniknelo nic — a to jedyny sygnal,
  // po ktorym czlowiek zauwaza, ze sklep sie sypie.
  it('licznik zniknięć liczy WYŁĄCZNIE to, czego w tym przebiegu nie było', async () => {
    const db = openOmsDb(':memory:');
    const trzy = [prosty({ id: 1 }), prosty({ id: 2 }), prosty({ id: 3 })];
    await odswiezMagazyn({ kanalySklepow: ['pro', 'szkicownia'], kanalyAllegro: ['allegro_szkicownia', 'allegro_amarka'],  db, sklepy: { pro: sklepAtrapa(trzy) }, allegro: null, teraz: teraz('2026-08-06T10:00:00Z') });
    const w = await odswiezMagazyn({ kanalySklepow: ['pro', 'szkicownia'], kanalyAllegro: ['allegro_szkicownia', 'allegro_amarka'], 
      db, sklepy: { pro: sklepAtrapa(trzy) }, allegro: null, teraz: teraz('2026-08-07T10:00:00Z'),
    });
    expect(kanal(w, 'pro').znikniete).toBe(0);
    expect(db.prepare('SELECT COUNT(*) c FROM produkty_sklepowe WHERE zniknal_at IS NOT NULL').get().c).toBe(0);
  });

  it('zniknięcie w jednym kanale nie dotyka katalogu drugiego', async () => {
    const db = openOmsDb(':memory:');
    const sklepy = { pro: sklepAtrapa([prosty({ id: 1 })]), szkicownia: sklepAtrapa([prosty({ id: 2 })]) };
    await odswiezMagazyn({ kanalySklepow: ['pro', 'szkicownia'], kanalyAllegro: ['allegro_szkicownia', 'allegro_amarka'],  db, sklepy, allegro: null, teraz: teraz('2026-08-06T10:00:00Z') });
    const w = await odswiezMagazyn({ kanalySklepow: ['pro', 'szkicownia'], kanalyAllegro: ['allegro_szkicownia', 'allegro_amarka'], 
      db,
      // ⚠️ Na PRO przychodzi INNY produkt, a nie pusta lista: od hamulca pustego odczytu
      // (niżej) zerowy odczyt przy żywym lustrze jest awarią kanału, więc nie da się już
      // nim udawać „wszystko zniknęło". Zniknięcie wymusza więc podmiana katalogu.
      sklepy: { pro: sklepAtrapa([prosty({ id: 3 })]), szkicownia: sklepAtrapa([prosty({ id: 2 })]) },
      allegro: null,
      teraz: teraz('2026-08-07T10:00:00Z'),
    });
    expect(kanal(w, 'pro').znikniete).toBe(1);
    expect(kanal(w, 'szkicownia').znikniete).toBe(0);
    expect(db.prepare('SELECT kanal FROM produkty_sklepowe WHERE zniknal_at IS NOT NULL').all())
      .toEqual([{ kanal: 'pro' }]);
  });

  it('produkt, który wrócił do sklepu, przestaje być zniknięty', async () => {
    const db = openOmsDb(':memory:');
    await odswiezMagazyn({ kanalySklepow: ['pro', 'szkicownia'], kanalyAllegro: ['allegro_szkicownia', 'allegro_amarka'], 
      db, sklepy: { pro: sklepAtrapa([prosty({ id: 1 })]) }, allegro: null, teraz: teraz('2026-08-06T10:00:00Z'),
    });
    // ⚠️ Środkowy przebieg MUSI coś oddać (inny produkt), bo od hamulca pustego odczytu
    // zerowa lista przy żywym lustrze jest awarią kanału i NIE oznaczyłaby niczego — a wtedy
    // ten test sprawdzałby zerowanie znacznika, którego nigdy nie postawiono.
    await odswiezMagazyn({ kanalySklepow: ['pro', 'szkicownia'], kanalyAllegro: ['allegro_szkicownia', 'allegro_amarka'], 
      db, sklepy: { pro: sklepAtrapa([prosty({ id: 2 })]) }, allegro: null, teraz: teraz('2026-08-07T10:00:00Z'),
    });
    expect(db.prepare('SELECT zniknal_at FROM produkty_sklepowe WHERE produkt_id = 1').get().zniknal_at)
      .toBe('2026-08-07T10:00:00.000Z');
    await odswiezMagazyn({ kanalySklepow: ['pro', 'szkicownia'], kanalyAllegro: ['allegro_szkicownia', 'allegro_amarka'], 
      db, sklepy: { pro: sklepAtrapa([prosty({ id: 1 })]) }, allegro: null, teraz: teraz('2026-08-08T10:00:00Z'),
    });
    expect(db.prepare('SELECT zniknal_at FROM produkty_sklepowe WHERE produkt_id = 1').get().zniknal_at).toBe(null);
  });

  // ⚠️ POWIAZANIE Z KARTĄ JEST RECZNA PRACA WLASCICIELA i ma przezyc kazdy odczyt —
  // takze ten, w ktorym produkt zniknal ze sklepu.
  it('odczyt nie zrywa powiązania karty z produktem', async () => {
    const db = openOmsDb(':memory:');
    await odswiezMagazyn({ kanalySklepow: ['pro', 'szkicownia'], kanalyAllegro: ['allegro_szkicownia', 'allegro_amarka'], 
      db, sklepy: { pro: sklepAtrapa([prosty({ id: 1 })]) }, allegro: null, teraz: teraz('2026-08-06T10:00:00Z'),
    });
    db.prepare("INSERT INTO karty_produktow (nazwa, utworzony_at, zmieniony_at) VALUES ('W', 'x', 'x')").run();
    db.prepare('UPDATE produkty_sklepowe SET karta_id = 1').run();
    await odswiezMagazyn({ kanalySklepow: ['pro', 'szkicownia'], kanalyAllegro: ['allegro_szkicownia', 'allegro_amarka'], 
      db, sklepy: { pro: sklepAtrapa([prosty({ id: 1, name: 'Nowa nazwa' })]) }, allegro: null, teraz: teraz('2026-08-07T10:00:00Z'),
    });
    expect(jeden(db)).toMatchObject({ karta_id: 1, nazwa: 'Nowa nazwa' });
  });
});

// ============================================================================
// ZNACZNIK CZASU
// ============================================================================

describe('odswiezMagazyn — znacznik czasu', () => {
  // ⚠️⚠️ `odczytane_at` jest porownywane LEKSYKOGRAFICZNIE (`odczytane_at < ?`
  // w `oznaczZnikniete`). Jeden „+02:00" zamiast „Z" i porownanie zaczyna klamac:
  // przebieg o 11:00 UTC nie oznaczy niczego, bo zapisane „12:00+02:00" wyglada dla SQLite
  // na PÓŹNIEJSZE niz „11:00Z", mimo ze jest o godzine wczesniejsze.
  it('znacznik jest wymuszany na UTC, więc porównanie tekstowe nie kłamie', async () => {
    const db = openOmsDb(':memory:');
    await odswiezMagazyn({ kanalySklepow: ['pro', 'szkicownia'], kanalyAllegro: ['allegro_szkicownia', 'allegro_amarka'], 
      db,
      sklepy: { pro: sklepAtrapa([prosty({ id: 1 })]) },
      allegro: null,
      teraz: teraz('2026-08-06T12:00:00+02:00'),
    });
    expect(jeden(db).odczytane_at).toBe('2026-08-06T10:00:00.000Z');

    // Godzinę później (UTC) sklep pokazuje już INNY produkt — pierwszy ma zniknąć. Zerową
    // listą nie da się tego wymusić od czasu hamulca pustego odczytu (niżej).
    const w = await odswiezMagazyn({ kanalySklepow: ['pro', 'szkicownia'], kanalyAllegro: ['allegro_szkicownia', 'allegro_amarka'], 
      db, sklepy: { pro: sklepAtrapa([prosty({ id: 2 })]) }, allegro: null, teraz: teraz('2026-08-06T11:00:00Z'),
    });
    expect(kanal(w, 'pro').znikniete).toBe(1);
    expect(db.prepare('SELECT produkt_id FROM produkty_sklepowe WHERE zniknal_at IS NOT NULL').all())
      .toEqual([{ produkt_id: '1' }]);
  });

  it('znacznik zawsze ma kształt ISO z Z na końcu', async () => {
    const db = openOmsDb(':memory:');
    for (const wartosc of ['2026-08-06T10:00:00Z', '2026-08-06T12:00:00+02:00', new Date('2026-08-06T10:00:00Z')]) {
      await odswiezMagazyn({ kanalySklepow: ['pro', 'szkicownia'], kanalyAllegro: ['allegro_szkicownia', 'allegro_amarka'],  db, sklepy: { pro: sklepAtrapa([prosty({ id: 1 })]) }, allegro: null, teraz: () => wartosc });
      expect(jeden(db).odczytane_at).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/);
    }
  });

  // ⚠️ ZEGAR PYTANY RAZ NA PRZEBIEG, nie przy kazdym wierszu. Przy pytaniu per wiersz
  // wczesniejsze wiersze TEGO SAMEGO przebiegu maja starszy znacznik niz ten, ktorym
  // `oznaczZnikniete` tnie — i przebieg oznacza jako znikniete produkty, ktore wlasnie
  // przeczytal ze sklepu.
  it('zegar pytany raz na przebieg — wszystkie wiersze mają ten sam znacznik', async () => {
    const db = openOmsDb(':memory:');
    let i = 0;
    const zegarRuchomy = () => `2026-08-06T10:0${i++}:00Z`;
    const w = await odswiezMagazyn({ kanalySklepow: ['pro', 'szkicownia'], kanalyAllegro: ['allegro_szkicownia', 'allegro_amarka'], 
      db,
      sklepy: { pro: sklepAtrapa([prosty({ id: 1 }), prosty({ id: 2 }), prosty({ id: 3 })]) },
      allegro: { allegro_szkicownia: allegroAtrapa([oferta('4'), oferta('5')]) },
      teraz: zegarRuchomy,
    });
    expect(new Set(wiersze(db).map((r) => r.odczytane_at)).size).toBe(1);
    expect(w.kanaly.every((k) => k.znikniete === 0)).toBe(true);
    expect(db.prepare('SELECT COUNT(*) c FROM produkty_sklepowe WHERE zniknal_at IS NOT NULL').get().c).toBe(0);
  });

  // Zegar oddajacy smiec ma sie wywalic PRZED pierwszym zapisem, a nie zostawic w kolumnie
  // „Invalid Date" — po niej `oznaczZnikniete` nie oznaczyloby juz nigdy niczego.
  it('zegar oddający śmieć wywala przebieg, zanim cokolwiek trafi do bazy', async () => {
    const db = openOmsDb(':memory:');
    const sklep = sklepAtrapa([prosty()]);
    await expect(odswiezMagazyn({ kanalySklepow: ['pro', 'szkicownia'], kanalyAllegro: ['allegro_szkicownia', 'allegro_amarka'],  db, sklepy: { pro: sklep }, allegro: null, teraz: () => 'wczoraj' }))
      .rejects.toThrow(/wczoraj/);
    expect(wiersze(db)).toEqual([]);
    expect(sklep.pobierzWszystkieProdukty.mock.calls.length).toBe(0);
  });
});

// ============================================================================
// POSTEP — odczyt ma dac sie uruchomic w tle i pokazac, ile zrobil
// ============================================================================

describe('odswiezMagazyn — postęp', () => {
  it('melduje postęp z nazwą kanału i licznikami', async () => {
    const db = openOmsDb(':memory:');
    const postep = vi.fn();
    await odswiezMagazyn({ kanalySklepow: ['pro', 'szkicownia'], kanalyAllegro: ['allegro_szkicownia', 'allegro_amarka'], 
      db,
      sklepy: { pro: sklepAtrapa([prosty({ id: 1 }), prosty({ id: 2 })]) },
      allegro: { allegro_szkicownia: allegroAtrapa([oferta('3')]) },
      teraz: teraz(),
      postep,
    });
    expect(postep.mock.calls.map(([i]) => [i.kanal, i.zrobione, i.zTego])).toEqual([
      ['pro', 1, 2], ['pro', 2, 2], ['allegro_szkicownia', 1, 1],
    ]);
  });

  // Postep jest OZDOBA (ta sama zasada, co przy miniaturach ofert): jego awaria nie ma prawa
  // wywalic odczytu — bo wywalony kanal nie dochodzi do `oznaczZnikniete`, czyli usterka
  // paska postepu zamrazalaby lustro.
  it('postęp, który rzuca, nie psuje przebiegu', async () => {
    const db = openOmsDb(':memory:');
    const w = await odswiezMagazyn({ kanalySklepow: ['pro', 'szkicownia'], kanalyAllegro: ['allegro_szkicownia', 'allegro_amarka'], 
      db,
      sklepy: { pro: sklepAtrapa([prosty()]) },
      allegro: null,
      teraz: teraz(),
      postep: () => { throw new Error('pasek padł'); },
    });
    expect(kanal(w, 'pro').blad).toBe(null);
    expect(kanal(w, 'pro').zapisane).toBe(1);
  });

  it('brak funkcji postępu jest stanem normalnym', async () => {
    const db = openOmsDb(':memory:');
    const w = await odswiezMagazyn({ kanalySklepow: ['pro', 'szkicownia'], kanalyAllegro: ['allegro_szkicownia', 'allegro_amarka'],  db, sklepy: { pro: sklepAtrapa([prosty()]) }, allegro: null, teraz: teraz() });
    expect(kanal(w, 'pro').zapisane).toBe(1);
  });
});

// ============================================================================
// HAMULEC: PUSTY ODCZYT PRZY NIEPUSTYM LUSTRZE
// ============================================================================

describe('odswiezMagazyn — pusty odczyt przy żywym lustrze', () => {
  // Zmierzone na prawdziwej bazie: 668 produktow w lustrze, klient oddaje `[]`, wynik
  // `{ zapisane: 0, znikniete: 668, blad: null }` — czyli przebieg MELDUJE SUKCES, a magazyn
  // pokazuje pusty kanal. Sklep odmawia KODEM 200 (konflikt wtyczki, tryb konserwacji,
  // nieudany import masowy), wiec klient nie ma czego zglosic: tablica jest tablica,
  // a kontrola kompletnosci przy `totalCount = 0` jest swiadomie pomijana.
  const dwaWiersze = () => [prosty({ id: 1 }), prosty({ id: 2 })];

  it('zero pozycji przy niepustym lustrze to AWARIA kanału, nie pustka', async () => {
    const db = openOmsDb(':memory:');
    await odswiezMagazyn({ kanalySklepow: ['pro', 'szkicownia'], kanalyAllegro: ['allegro_szkicownia', 'allegro_amarka'], 
      db, sklepy: { szkicownia: sklepAtrapa(dwaWiersze()) }, allegro: null, teraz: teraz('2026-08-06T10:00:00Z'),
    });
    const w = await odswiezMagazyn({ kanalySklepow: ['pro', 'szkicownia'], kanalyAllegro: ['allegro_szkicownia', 'allegro_amarka'], 
      db, sklepy: { szkicownia: sklepAtrapa([]) }, allegro: null, teraz: teraz('2026-08-07T10:00:00Z'),
    });
    expect(kanal(w, 'szkicownia').blad).toBeTruthy();
    expect(kanal(w, 'szkicownia').znikniete).toBe(0);
    expect(db.prepare('SELECT COUNT(*) c FROM produkty_sklepowe WHERE zniknal_at IS NOT NULL').get().c).toBe(0);
    // Lustro ma zostac DOKLADNIE takie, jakie bylo — razem ze znacznikiem odczytu.
    expect(db.prepare("SELECT COUNT(*) c FROM produkty_sklepowe WHERE odczytane_at LIKE '2026-08-06%'").get().c).toBe(2);
  });

  // Ten tekst czlowiek zobaczy o 7 rano i ma od razu wiedziec, gdzie szukac.
  it('komunikat nazywa kanał, obie liczby i mówi wprost o awarii sklepu', async () => {
    const db = openOmsDb(':memory:');
    await odswiezMagazyn({ kanalySklepow: ['pro', 'szkicownia'], kanalyAllegro: ['allegro_szkicownia', 'allegro_amarka'], 
      db, sklepy: { szkicownia: sklepAtrapa(dwaWiersze()) }, allegro: null, teraz: teraz('2026-08-06T10:00:00Z'),
    });
    const w = await odswiezMagazyn({ kanalySklepow: ['pro', 'szkicownia'], kanalyAllegro: ['allegro_szkicownia', 'allegro_amarka'], 
      db, sklepy: { szkicownia: sklepAtrapa([]) }, allegro: null, teraz: teraz('2026-08-07T10:00:00Z'),
    });
    const blad = kanal(w, 'szkicownia').blad;
    expect(blad).toMatch(/szkicownia/);
    expect(blad).toMatch(/\b0\b/);
    expect(blad).toMatch(/\b2\b/);
    expect(blad).toMatch(/awari/i);
  });

  // ⚠️⚠️ PARA DO HAMULCA — bez niej straznik zaostrzony do „pusty odczyt zawsze jest bledem"
  // przechodzilby na zielono i wywalalby PIERWSZY przebieg kazdego nowego kanalu.
  it('zero pozycji przy PUSTYM lustrze przechodzi normalnie', async () => {
    const db = openOmsDb(':memory:');
    const w = await odswiezMagazyn({ kanalySklepow: ['pro', 'szkicownia'], kanalyAllegro: ['allegro_szkicownia', 'allegro_amarka'], 
      db, sklepy: { pro: sklepAtrapa([]) }, allegro: { allegro_amarka: allegroAtrapa([]) }, teraz: teraz(),
    });
    expect(w.kanaly.map((k) => [k.kanal, k.zapisane, k.znikniete, k.blad]))
      .toEqual([['pro', 0, 0, null], ['allegro_amarka', 0, 0, null]]);
  });

  // Druga polowa pary: kanal, ktorego caly katalog jest JUZ oznaczony jako znikniety, nie ma
  // czego stracic — pusty odczyt jest tam stanem ustalonym, a nie nowa awaria. Bez tego
  // przypadku hamulec liczacy WSZYSTKIE wiersze (zamiast zywych) przechodzilby na zielono
  // i zamrazalby na zawsze kanal wygaszony przed miesiacem.
  it('zero pozycji przy lustrze z samymi zniknięciami przechodzi', async () => {
    const db = openOmsDb(':memory:');
    await odswiezMagazyn({ kanalySklepow: ['pro', 'szkicownia'], kanalyAllegro: ['allegro_szkicownia', 'allegro_amarka'], 
      db, sklepy: { pro: sklepAtrapa([prosty()]) }, allegro: null, teraz: teraz('2026-08-06T10:00:00Z'),
    });
    db.prepare("UPDATE produkty_sklepowe SET zniknal_at = '2026-08-06T12:00:00.000Z'").run();
    const w = await odswiezMagazyn({ kanalySklepow: ['pro', 'szkicownia'], kanalyAllegro: ['allegro_szkicownia', 'allegro_amarka'], 
      db, sklepy: { pro: sklepAtrapa([]) }, allegro: null, teraz: teraz('2026-08-07T10:00:00Z'),
    });
    expect(kanal(w, 'pro').blad).toBe(null);
  });

  // ⚠️ Hamulec liczy WYLACZNIE swoj kanal. Bez warunku `kanal = ?` pusty odczyt na PRO byłby
  // blokowany przez 668 zywych wierszy sklepu A — czyli kanal, ktory naprawde nic nie ma,
  // nie dalby sie odczytac NIGDY.
  it('hamulec patrzy tylko na własny kanał', async () => {
    const db = openOmsDb(':memory:');
    await odswiezMagazyn({ kanalySklepow: ['pro', 'szkicownia'], kanalyAllegro: ['allegro_szkicownia', 'allegro_amarka'], 
      db, sklepy: { szkicownia: sklepAtrapa(dwaWiersze()) }, allegro: null, teraz: teraz('2026-08-06T10:00:00Z'),
    });
    const w = await odswiezMagazyn({ kanalySklepow: ['pro', 'szkicownia'], kanalyAllegro: ['allegro_szkicownia', 'allegro_amarka'], 
      db,
      sklepy: { pro: sklepAtrapa([]), szkicownia: sklepAtrapa(dwaWiersze()) },
      allegro: null,
      teraz: teraz('2026-08-07T10:00:00Z'),
    });
    expect(kanal(w, 'pro').blad).toBe(null);
    expect(kanal(w, 'szkicownia').zapisane).toBe(2);
  });

  // ⚠️⚠️ NAJWAZNIEJSZA PARA: hamulec lapie WYLACZNIE zero, nigdy „mniej, niz bylo". Wlasciciel
  // wygaszajacy katalog stopniowo (albo kasujacy jedna pozycje) ma dostac normalny przebieg
  // ze zniknieciem, a nie zamrozony kanal. Straznik zaostrzony do „odczyt mniejszy niz lustro"
  // uniemozliwilby wycofanie czegokolwiek ze sprzedazy.
  it('jedna pozycja przy dwóch w lustrze to normalne zniknięcie, nie awaria', async () => {
    const db = openOmsDb(':memory:');
    await odswiezMagazyn({ kanalySklepow: ['pro', 'szkicownia'], kanalyAllegro: ['allegro_szkicownia', 'allegro_amarka'], 
      db, sklepy: { pro: sklepAtrapa(dwaWiersze()) }, allegro: null, teraz: teraz('2026-08-06T10:00:00Z'),
    });
    const w = await odswiezMagazyn({ kanalySklepow: ['pro', 'szkicownia'], kanalyAllegro: ['allegro_szkicownia', 'allegro_amarka'], 
      db, sklepy: { pro: sklepAtrapa([prosty({ id: 1 })]) }, allegro: null, teraz: teraz('2026-08-07T10:00:00Z'),
    });
    expect(kanal(w, 'pro').blad).toBe(null);
    expect(kanal(w, 'pro').znikniete).toBe(1);
  });

  // Allegro odmawia tak samo cicho: `{ offers: [], totalCount: 0 }` przechodzi przez kontrole
  // kompletnosci klienta bez slowa.
  it('konto Allegro, które nagle nie ma ofert, też jest zatrzymane', async () => {
    const db = openOmsDb(':memory:');
    await odswiezMagazyn({ kanalySklepow: ['pro', 'szkicownia'], kanalyAllegro: ['allegro_szkicownia', 'allegro_amarka'], 
      db, sklepy: null, allegro: { allegro_szkicownia: allegroAtrapa([oferta('1')]) }, teraz: teraz('2026-08-06T10:00:00Z'),
    });
    const w = await odswiezMagazyn({ kanalySklepow: ['pro', 'szkicownia'], kanalyAllegro: ['allegro_szkicownia', 'allegro_amarka'], 
      db, sklepy: null, allegro: { allegro_szkicownia: allegroAtrapa([]) }, teraz: teraz('2026-08-07T10:00:00Z'),
    });
    expect(kanal(w, 'allegro_szkicownia').blad).toMatch(/allegro_szkicownia/);
    expect(db.prepare('SELECT zniknal_at FROM produkty_sklepowe').get().zniknal_at).toBe(null);
  });

  it('kanał zatrzymany hamulcem nie przerywa pozostałych', async () => {
    const db = openOmsDb(':memory:');
    await odswiezMagazyn({ kanalySklepow: ['pro', 'szkicownia'], kanalyAllegro: ['allegro_szkicownia', 'allegro_amarka'], 
      db, sklepy: { pro: sklepAtrapa([prosty({ id: 1 })]) }, allegro: null, teraz: teraz('2026-08-06T10:00:00Z'),
    });
    const w = await odswiezMagazyn({ kanalySklepow: ['pro', 'szkicownia'], kanalyAllegro: ['allegro_szkicownia', 'allegro_amarka'], 
      db,
      sklepy: { pro: sklepAtrapa([]), szkicownia: sklepAtrapa([prosty({ id: 5 })]) },
      allegro: null,
      teraz: teraz('2026-08-07T10:00:00Z'),
    });
    expect(kanal(w, 'pro').blad).toBeTruthy();
    expect(kanal(w, 'szkicownia').zapisane).toBe(1);
  });
});

// ============================================================================
// LOG — cichy blad kanalu wyglada dokladnie tak samo jak sklep bez zmian
// ============================================================================

describe('odswiezMagazyn — ślad w logu', () => {
  it('błąd kanału trafia do logu razem z nazwą kanału', async () => {
    const db = openOmsDb(':memory:');
    const wpisy = [];
    await odswiezMagazyn({ kanalySklepow: ['pro', 'szkicownia'], kanalyAllegro: ['allegro_szkicownia', 'allegro_amarka'], 
      db,
      sklepy: {
        pro: { pobierzWszystkieProdukty: async () => { throw new Error('Sklep odrzucił klucz REST'); } },
        szkicownia: sklepAtrapa([prosty({ id: 5 })]),
      },
      allegro: null,
      teraz: teraz(),
      log: (...a) => wpisy.push(a.join(' ')),
    });
    expect(wpisy.length).toBe(1);
    expect(wpisy[0]).toMatch(/pro/);
    expect(wpisy[0]).toMatch(/klucz REST/);
  });

  // ⚠️ PARA: log ma MILCZEC, gdy nic sie nie stalo. Bez tego straznik piszacy przy kazdym
  // kanale zalewalby wyjscie kontenera przy KAZDYM przebiegu i to on stalby sie szumem,
  // w ktorym ginie prawdziwa awaria.
  it('przebieg bez błędów nie pisze do logu ani słowa', async () => {
    const db = openOmsDb(':memory:');
    const wpisy = [];
    await odswiezMagazyn({ kanalySklepow: ['pro', 'szkicownia'], kanalyAllegro: ['allegro_szkicownia', 'allegro_amarka'], 
      db,
      sklepy: { pro: sklepAtrapa([prosty()]) },
      allegro: { allegro_szkicownia: allegroAtrapa([oferta('1')]) },
      teraz: teraz(),
      log: (...a) => wpisy.push(a.join(' ')),
    });
    expect(wpisy).toEqual([]);
  });

  // Ta sama zasada, co przy postepie: slad jest OZDOBA wobec wyniku. Log, ktory rzuca
  // w bloku obslugi bledu, wyrzucilby wyjatek Z `przebiegKanalu` — czyli usterka logowania
  // zabilaby izolacje awarii i zatrzymala pozostale kanaly.
  it('log, który rzuca, nie przewraca przebiegu ani nie gubi błędu', async () => {
    const db = openOmsDb(':memory:');
    const w = await odswiezMagazyn({ kanalySklepow: ['pro', 'szkicownia'], kanalyAllegro: ['allegro_szkicownia', 'allegro_amarka'], 
      db,
      sklepy: {
        pro: { pobierzWszystkieProdukty: async () => { throw new Error('leży'); } },
        szkicownia: sklepAtrapa([prosty({ id: 5 })]),
      },
      allegro: null,
      teraz: teraz(),
      log: () => { throw new Error('log padł'); },
    });
    expect(kanal(w, 'pro').blad).toMatch(/leży/);
    expect(kanal(w, 'szkicownia').zapisane).toBe(1);
  });

  // Bez wstrzyknietego logu slad ma isc tam, gdzie idzie kazdy inny slad panelu: do wyjscia
  // kontenera. To jedyne miejsce, w ktorym czlowiek zobaczy awarie kanalu, zanim otworzy magazyn.
  it('domyślnie ślad idzie do console.error', async () => {
    const db = openOmsDb(':memory:');
    const szpieg = vi.spyOn(console, 'error').mockImplementation(() => {});
    let wypisane = '';
    try {
      await odswiezMagazyn({ kanalySklepow: ['pro', 'szkicownia'], kanalyAllegro: ['allegro_szkicownia', 'allegro_amarka'], 
        db,
        sklepy: { pro: { pobierzWszystkieProdukty: async () => { throw new Error('leży'); } } },
        allegro: null,
        teraz: teraz(),
      });
      wypisane = szpieg.mock.calls.map((a) => a.join(' ')).join(' | ');
    } finally {
      szpieg.mockRestore();
    }
    expect(wypisane).toMatch(/pro/);
    expect(wypisane).toMatch(/leży/);
  });
});

// ============================================================================
// ATRYBUTY WARIANTU (2026-08-11)
// ============================================================================
//
// ⚠️⚠️ ZRODLEM SA `attributes` Z ODPOWIEDZI WOOCOMMERCE, NIGDY PERMALINK. Wariant niesie
// osie podzialu takze w adresie (`?attribute_uklad=RÓWNOLEGLE`), ale permalink jest OZDOBA:
// sklep moze go przebudowac, przepisac na identyfikatory albo wylaczyc ladne adresy. Panel,
// ktory czytalby atrybuty stamtad, dowiedzialby sie o zmianie dopiero po zalozeniu setek
// kart o zlych nazwach — i to nieodwracalnie ponumerowanych.
describe('odswiezMagazyn — atrybuty wariantu', () => {
  it('zapisuje osie podzialu wariantu z odpowiedzi sklepu', async () => {
    const db = openOmsDb(':memory:');
    const sklepy = {
      szkicownia: sklepAtrapa(
        [{ id: 7179, type: 'variable', name: 'Kolekcja Las' }],
        {
          7179: [{
            id: 7180,
            price: '79',
            // Adres NIESIE te sama informacje — i celowo mowi co innego niz atrybut.
            // Gdyby wygral permalink, w kolumnie stanelaby „Żołądź".
            permalink: 'https://sklep-polcien.example.invalid/produkt/kolekcja-las/?attribute_motyw=%C5%BBo%C5%82%C4%85d%C5%BA',
            attributes: [{ id: 5, name: 'motyw', option: 'Szyszka' }],
          }],
        },
      ),
    };

    await odswiezMagazyn({ kanalySklepow: ['pro', 'szkicownia'], kanalyAllegro: ['allegro_szkicownia', 'allegro_amarka'],  db, sklepy, allegro: null, teraz: teraz() });

    expect(JSON.parse(jeden(db).atrybuty_json)).toEqual([{ nazwa: 'motyw', wartosc: 'Szyszka' }]);
  });

  // ⚠️ PARA: wariant, ktoremu sklep nie dal ZADNEGO atrybutu, ma dostac PUSTA TABLICE, a nie
  // NULL. To sa `Koła duże` i `X` — a roznica jest cala trescia ekranu „pominiete": '[]' znaczy
  // „popraw sklep", NULL znaczy „panel jeszcze nie czytal". Zapisanie tu NULL-a zostawiloby te
  // 6 wierszy na zawsze w stanie „kliknij Odczytaj katalogi", mimo ze wlasnie to zrobiono.
  it('wariant bez atrybutow dostaje PUSTA TABLICE, nie NULL', async () => {
    const db = openOmsDb(':memory:');
    const sklepy = {
      szkicownia: sklepAtrapa(
        [{ id: 26953, type: 'variable', name: 'Koła duże' }],
        { 26953: [{ id: 26954, price: '79', attributes: [] }] },
      ),
    };

    await odswiezMagazyn({ kanalySklepow: ['pro', 'szkicownia'], kanalyAllegro: ['allegro_szkicownia', 'allegro_amarka'],  db, sklepy, allegro: null, teraz: teraz() });

    expect(jeden(db).atrybuty_json).toBe('[]');
  });

  // ⚠️ PARA MILCZENIA: produkt PROSTY ma w Woo wlasne `attributes`, ale to nie sa osie podzialu
  // — nie ma czego dzielic. Zapisanie ich tutaj kazaloby `kartaZProduktu` dopisac wartosc
  // atrybutu do nazwy kazdego z ~588 prostych produktow sklepu A.
  it('produkt prosty NIE dostaje atrybutow wariantu', async () => {
    const db = openOmsDb(':memory:');
    const sklepy = {
      pro: sklepAtrapa([prosty({ attributes: [{ name: 'Kolor', options: ['czarny'] }] })]),
    };

    await odswiezMagazyn({ kanalySklepow: ['pro', 'szkicownia'], kanalyAllegro: ['allegro_szkicownia', 'allegro_amarka'],  db, sklepy, allegro: null, teraz: teraz() });

    expect(jeden(db).atrybuty_json).toBe(null);
  });
});
