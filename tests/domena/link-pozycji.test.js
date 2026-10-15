import { describe, it, expect } from 'vitest';
import { odnosnikPozycji } from '../../src/domena/link-pozycji.js';
import { SKU_PLACEHOLDERA } from '../../src/domena/indywidualne.js';

const SKLEP = 'https://szkicownia.pl';

// Kanal rozpoznaje sie po `zamowienia.sklep` — TA SAMA wartosc, ktora rozdziela zamowienia
// w bazie i w pollerze (config.js, KANALY).
const zeSklepu = { sklep: 'szkicownia' };
const zAllegro = { sklep: 'allegro_szkicownia' };

const wiersz = (nad = {}) => ({ produktId: 28040, ofertaId: null, sku: 'PRO-1', reczna: false, ...nad });
const adres = (...a) => odnosnikPozycji(...a)?.adres ?? null;

describe('odnosnikPozycji — sklep (WooCommerce)', () => {
  it('sklada adres po identyfikatorze produktu', () => {
    expect(adres(zeSklepu, wiersz({ produktId: 31337 }), { baseUrl: SKLEP }))
      .toBe('https://szkicownia.pl/?post_type=product&p=31337');
  });

  it('ucina koncowy ukosnik adresu sklepu', () => {
    expect(adres(zeSklepu, wiersz({ produktId: 5 }), { baseUrl: 'https://szkicownia.pl/' }))
      .toBe('https://szkicownia.pl/?post_type=product&p=5');
  });

  it('podpis odnosnika mowi o sklepie', () => {
    expect(odnosnikPozycji(zeSklepu, wiersz(), { baseUrl: SKLEP }).tytul).toBe('Otwórz produkt w sklepie');
  });

  // Cztery przypadki BEZ odnosnika — miniatura zostaje wtedy zwyklym obrazkiem.
  it('pozycja dopisana recznie nie ma produktu w sklepie', () => {
    expect(adres(zeSklepu, wiersz({ reczna: true }), { baseUrl: SKLEP })).toBe(null);
  });

  it('brak identyfikatora produktu daje brak odnosnika', () => {
    expect(adres(zeSklepu, wiersz({ produktId: null }), { baseUrl: SKLEP })).toBe(null);
    expect(adres(zeSklepu, wiersz({ produktId: 0 }), { baseUrl: SKLEP })).toBe(null);
  });

  it('sklep nieskonfigurowany (brak adresu) daje brak odnosnika', () => {
    expect(adres(zeSklepu, wiersz(), { baseUrl: null })).toBe(null);
    expect(adres(zeSklepu, wiersz(), { baseUrl: '' })).toBe(null);
    expect(adres(zeSklepu, wiersz())).toBe(null);
  });

  // ⚠️ Zaslepka panelu indywidualnego to wysylka albo realizacja priorytetowa, a nie towar.
  // Odnosnik prowadzilby operatora w slepy zaulek — wszystkie pozycje takiego zamowienia
  // maja TEN SAM product_id zaslepki (zmierzone na zywym sklepie, zamowienie 28046).
  it('pozycja z zaslepki panelu indywidualnego nie dostaje odnosnika', () => {
    expect(adres(zeSklepu, wiersz({ sku: SKU_PLACEHOLDERA }), { baseUrl: SKLEP })).toBe(null);
  });

  it('wiersz wysylki i „Razem" nie dostaja odnosnika', () => {
    expect(adres(zeSklepu, { produktId: null, ofertaId: null, sku: null, reczna: false }, { baseUrl: SKLEP }))
      .toBe(null);
  });

  // ⚠️ Granica w druga strone: identyfikator OFERTY nie ma prawa udawac produktu w sklepie.
  // Bez tego pozycja z Allegro zapisana omylkowo pod sklepowym kanalem prowadzilaby do
  // `szkicownia.pl/?post_type=product&p=9000000001` — adresu, ktorego nie ma.
  it('sam identyfikator oferty nie robi odnosnika w kanale sklepowym', () => {
    expect(adres(zeSklepu, wiersz({ produktId: null, ofertaId: '9000000001' }), { baseUrl: SKLEP })).toBe(null);
  });
});

describe('odnosnikPozycji — Allegro', () => {
  // ⚠️ Identyfikator i adres z ZYWEGO zamowienia produkcyjnego; adres otwarty i sprawdzony
  // w prawdziwej przegladarce (WAF Allegro oddaje 403 na `fetch`, wiec kod odpowiedzi
  // niczego by nie dowodzil — patrz komentarz w domain/link-pozycji.js).
  it('pozycja prowadzi do swojej oferty', () => {
    expect(adres(zAllegro, wiersz({ produktId: null, ofertaId: '9000000001' })))
      .toBe('https://allegro.pl/oferta/9000000001');
  });

  it('podpis odnosnika mowi o ofercie na Allegro', () => {
    expect(odnosnikPozycji(zAllegro, wiersz({ produktId: null, ofertaId: '9000000001' })).tytul)
      .toBe('Otwórz ofertę na Allegro');
  });

  it('oba kanaly Allegro dzialaja tak samo', () => {
    expect(adres({ sklep: 'allegro_amarka' }, wiersz({ ofertaId: '9000000001' })))
      .toBe('https://allegro.pl/oferta/9000000001');
  });

  // ⚠️ REGULA REPO: brak linku jest lepszy niz link otwierajacy pustke (domain/tracking.js).
  it('brak identyfikatora oferty daje BRAK odnosnika, a nie adres donikad', () => {
    expect(odnosnikPozycji(zAllegro, wiersz({ ofertaId: null }))).toBe(null);
    expect(odnosnikPozycji(zAllegro, wiersz({ ofertaId: '' }))).toBe(null);
    expect(odnosnikPozycji(zAllegro, wiersz({ ofertaId: '   ' }))).toBe(null);
    expect(odnosnikPozycji(zAllegro, {})).toBe(null);
  });

  // Wiersz doplaty niesie `zrodlo_id: 'doplata'` — gdyby ktos podstawil go pod oferte,
  // powstalby adres `allegro.pl/oferta/doplata`.
  it('wartosc nieliczbowa nie robi adresu', () => {
    expect(odnosnikPozycji(zAllegro, wiersz({ ofertaId: 'doplata' }))).toBe(null);
    expect(odnosnikPozycji(zAllegro, wiersz({ ofertaId: '76251520 21' }))).toBe(null);
    expect(odnosnikPozycji(zAllegro, wiersz({ ofertaId: '../../ktos-inny' }))).toBe(null);
  });

  it('pozycja dopisana recznie do zamowienia z Allegro nie ma oferty', () => {
    expect(odnosnikPozycji(zAllegro, wiersz({ ofertaId: '9000000001', reczna: true }))).toBe(null);
  });

  // ⚠️ Kanal Allegro NIE MA `baseUrl` w konfiguracji (`config.kanaly`, nie `config.sklepy`),
  // wiec trasa poda tu `null` — i to nie ma prawa zabrac odnosnika do oferty.
  it('brak adresu sklepu nie dotyczy Allegro', () => {
    expect(adres(zAllegro, wiersz({ ofertaId: '9000000001' }), { baseUrl: null }))
      .toBe('https://allegro.pl/oferta/9000000001');
  });

  // ⚠️ Granica w druga strone: identyfikator PRODUKTU nie ma prawa zrobic adresu oferty.
  it('sam produkt_id nie robi odnosnika w kanale Allegro', () => {
    expect(odnosnikPozycji(zAllegro, wiersz({ produktId: 28040, ofertaId: null }), { baseUrl: SKLEP })).toBe(null);
  });
});

describe('odnosnikPozycji — kanal nieznany', () => {
  it('zamowienie reczne idzie regula sklepowa (i bez adresu sklepu nie ma odnosnika)', () => {
    expect(adres({ sklep: 'reczne' }, wiersz())).toBe(null);
  });

  it('brak zamowienia nie wywala odnosnika', () => {
    expect(odnosnikPozycji(null, wiersz())).toBe(null);
    expect(odnosnikPozycji(undefined, wiersz(), { baseUrl: SKLEP })?.adres)
      .toBe('https://szkicownia.pl/?post_type=product&p=28040');
  });
});
