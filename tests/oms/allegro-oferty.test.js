// Odczyt OFERT Allegro do lustra magazynu (Zadanie 6).
//
// Dwie warstwy w jednym pliku, bo to jedna decyzja: `ofertaNaProdukt` (regula czysta,
// domain/) mowi CO zapisujemy, a `pobierzOferty` (client.js) mowi SKAD to bierzemy.
//
// ⚠️ WSZYSTKO JEDZIE NA ATRAPIE `fetch`. Ani jedno wywolanie w tym pliku nie ma prawa
// dotknac prawdziwego Allegro — token odswiezajacy jest jednorazowy, a kanal jedzie
// na produkcji.
import { describe, it, expect, vi } from 'vitest';
import { ofertaNaProdukt } from '../../src/domena/allegro-oferta.js';
const KANALY_ALLEGRO = ['allegro_szkicownia', 'allegro_amarka'];
import {
  createAllegroClient, LIMIT_STRONY_OFERT, MAKS_STRON_OFERT,
  LIMIT_ZAPYTANIA_OFERT_MS, LIMIT_ZAPYTANIA_ZAMOWIEN_MS, LIMIT_ZAPYTANIA_PRZESYLEK_MS,
} from '../../src/oms/allegro/client.js';

// Ksztalt zmierzony w Zadaniu 0 (notatka 2026-08-06): tyle i tylko tyle bierzemy z listy ofert.
const oferta = (nadpisz = {}) => ({
  id: '1234567890',
  name: 'Lampa stołowa Grzybek 30x45 cm',
  sellingMode: { price: { amount: '89.00', currency: 'PLN' } },
  primaryImage: { url: 'https://a.allegroimg.com/original/aaa/bbb' },
  publication: { status: 'ACTIVE' },
  ...nadpisz,
});

const KANAL = 'allegro_szkicownia';

describe('ofertaNaProdukt — oferta na wiersz lustra', () => {
  it('przepisuje ofertę na wiersz lustra', () => {
    const p = ofertaNaProdukt({
      id: '1234567890',
      name: 'Lampa stołowa Grzybek 30x45 cm',
      sellingMode: { price: { amount: '89.00', currency: 'PLN' } },
      primaryImage: { url: 'https://a.allegroimg.com/original/aaa/bbb' },
      external: { id: 'PRO-GRZYBEK-001' },
    }, KANAL, ['allegro_szkicownia', 'allegro_amarka']);

    expect(p.produkt_id).toBe('1234567890');
    expect(p.nazwa).toBe('Lampa stołowa Grzybek 30x45 cm');
    expect(p.cena_gr).toBe(8900);
    expect(p.sku_sklepu).toBe('PRO-GRZYBEK-001');
    expect(p.adres).toBe('https://allegro.pl/oferta/1234567890');
    expect(p.rozmiar_tekst).toBe('Lampa stołowa Grzybek 30x45 cm');
  });

  // ⚠️ Wiersz idzie wprost do `zapiszProduktSklepowy` (db/magazyn.js), ktore rozdziela dane
  // po KANALE — a upsert leci po `(kanal, produkt_id, wariant_id)`. Kanal wziety skadinad
  // rozjechalby sie z tym, co mapowanie uwaza za zrodlo wiersza.
  it('wiersz niesie kanał i pusty wariant — Allegro nie ma wariantów', () => {
    const p = ofertaNaProdukt(oferta(), 'allegro_amarka', ['allegro_szkicownia', 'allegro_amarka']);
    expect(p.kanal).toBe('allegro_amarka');
    // ⚠️ NIE `null`. W SQLite NULL-e w UNIQUE sa wzajemnie ROZNE, wiec przy NULL ta sama
    // oferta wpadalaby do tabeli przy KAZDYM odczycie i mnozyla wiersze.
    expect(p.wariant_id).toBe('');
  });

  // ⚠️ BIALA LISTA KANALOW. Kanal jest kluczem, po ktorym magazyn rozdziela wiersze
  // i po ktorym `oznaczZnikniete` decyduje, czyj katalog wlasnie zniknal. Literowka
  // („allegro_stencil") zalozylaby kanal-widmo: wiersze, ktorych nie widzi zaden filtr,
  // i katalog prawdziwego kanalu oznaczony jako wycofany przy nastepnym przebiegu.
  it('kanał spoza białej listy NIE zakłada widmowego kanału', () => {
    expect(() => ofertaNaProdukt(oferta(), 'allegro_stencil', ['allegro_szkicownia', 'allegro_amarka'])).toThrow(/allegro_stencil/);
    expect(() => ofertaNaProdukt(oferta(), 'ALLEGRO_SZKICOWNIA', ['allegro_szkicownia', 'allegro_amarka'])).toThrow(/kanał/i);
    expect(() => ofertaNaProdukt(oferta(), undefined, ['allegro_szkicownia', 'allegro_amarka'])).toThrow(/kanał/i);
    // Kanal SKLEPOWY tez nie: wiersz z Allegro w kanale `pro` wygladalby na liscie jak
    // produkt sklepu, a zapis SKU poleciałby do WooCommerce.
    expect(() => ofertaNaProdukt(oferta(), 'pro', ['allegro_szkicownia', 'allegro_amarka'])).toThrow(/pro/);
  });

  // ⚠️ PARA DO TESTU WYZEJ: straznik ma MILCZEC na obu prawdziwych kontach. Bez tego
  // warunek zaostrzony do jednego kanalu (albo odwrocony) przeszedlby na zielono,
  // a drugie konto — 29 ofert AmarkaPL — nie wczytaloby sie ani razu.
  it('oba prawdziwe konta przechodzą bez słowa', () => {
    expect(KANALY_ALLEGRO.map((kanal) => ofertaNaProdukt(oferta(), kanal, KANALY_ALLEGRO).kanal)).toEqual(['allegro_szkicownia', 'allegro_amarka']);
    for (const kanal of KANALY_ALLEGRO) {
      expect(ofertaNaProdukt(oferta(), kanal, ['allegro_szkicownia', 'allegro_amarka']).kanal).toBe(kanal);
    }
  });

  // ⚠️ Zmierzone przy Planie A i potwierdzone w Zadaniu 0: `offer.external` jest dzis `null`
  // na WSZYSTKICH sprawdzonych ofertach obu kont (0/40). Powiazanie produktu z oferta jest
  // przez to reczne — ale mapowanie ma to przezyc, a nie wywalic caly odczyt.
  it('brak external nie wywraca mapowania', () => {
    const p = ofertaNaProdukt({ id: '1', name: 'X', sellingMode: { price: { amount: '10.00', currency: 'PLN' } } }, KANAL, ['allegro_szkicownia', 'allegro_amarka']);
    expect(p.sku_sklepu).toBe(null);
  });

  it('external bez pola id też daje null, a nie undefined', () => {
    const p = ofertaNaProdukt(oferta({ external: {} }), KANAL, ['allegro_szkicownia', 'allegro_amarka']);
    // `undefined` node:sqlite ODMAWIA zwiazac — pole, ktorego Allegro nie przyslalo,
    // wywaliloby caly przebieg odczytu zamiast zostawic pusta kolumne.
    expect(p.sku_sklepu).toBe(null);
    expect(p.sku_sklepu).not.toBeUndefined();
  });

  // ⚠️ Identyfikator z wiodacym zerem przepuszczony przez liczbe wraca jako INNA oferta.
  it('identyfikator zostaje napisem, z wiodącymi zerami', () => {
    const p = ofertaNaProdukt({ id: '0071234567', name: 'X', sellingMode: { price: { amount: '1.00', currency: 'PLN' } } }, KANAL, ['allegro_szkicownia', 'allegro_amarka']);
    expect(p.produkt_id).toBe('0071234567');
    expect(p.adres).toBe('https://allegro.pl/oferta/0071234567');
  });

  // ⚠️ Powyzej 2^53 `Number()` nie tylko gubi cyfry — zapisana liczba wywala potem ODCZYT
  // z SQLite (RangeError), czyli JEDEN wiersz przestaje renderowac CALA liste magazynu.
  // `String(Number('9007199254740993'))` to '9007199254740992': innej oferty, cicho.
  it('identyfikator powyżej 2^53 przechodzi znak w znak', () => {
    const p = ofertaNaProdukt({ id: '9007199254740993', name: 'X', sellingMode: { price: { amount: '1.00', currency: 'PLN' } } }, KANAL, ['allegro_szkicownia', 'allegro_amarka']);
    expect(p.produkt_id).toBe('9007199254740993');
    expect(p.produkt_id).not.toBe(String(Number('9007199254740993')));
  });

  // Gdyby Allegro zaczelo oddawac identyfikator LICZBA, wiodace zera i cyfry powyzej 2^53
  // sa juz stracone w chwili `JSON.parse` — i zadne mapowanie ich nie odzyska. Ma o tym
  // powiedzieć wyjatek przy pierwszym odczycie, a nie cichy wiersz o zlym kluczu.
  it('identyfikator, który NIE jest napisem, wywala odczyt zamiast go po cichu przepisać', () => {
    expect(() => ofertaNaProdukt({ id: 1234567890, name: 'X' }, KANAL, ['allegro_szkicownia', 'allegro_amarka'])).toThrow(/identyfikator/i);
    expect(() => ofertaNaProdukt({ name: 'X' }, KANAL, ['allegro_szkicownia', 'allegro_amarka'])).toThrow(/identyfikator/i);
    expect(() => ofertaNaProdukt({ id: '', name: 'X' }, KANAL, ['allegro_szkicownia', 'allegro_amarka'])).toThrow(/identyfikator/i);
    expect(() => ofertaNaProdukt(null, KANAL, ['allegro_szkicownia', 'allegro_amarka'])).toThrow(/identyfikator/i);
  });

  // `produkty_sklepowe.nazwa` jest NOT NULL, a nazwa oferty to JEDYNA rzecz, po ktorej
  // czlowiek wiaze oferte z produktem (SKU nie ma — `external` jest puste). Wiersz bez nazwy
  // jest bezuzyteczny, a bez tego straznika wywalilby sie dopiero na bazie, komunikatem
  // „NOT NULL constraint failed" w polowie 447 ofert.
  it('oferta bez nazwy wywala mapowanie, a nie zapis do bazy', () => {
    expect(() => ofertaNaProdukt({ id: '1' }, KANAL, ['allegro_szkicownia', 'allegro_amarka'])).toThrow(/nazw/i);
    expect(() => ofertaNaProdukt({ id: '1', name: '   ' }, KANAL, ['allegro_szkicownia', 'allegro_amarka'])).toThrow(/nazw/i);
    // Komunikat ma powiedziec, KTORA oferta — 447 ofert w jednym przebiegu.
    expect(() => ofertaNaProdukt({ id: '1234567890' }, KANAL, ['allegro_szkicownia', 'allegro_amarka'])).toThrow(/1234567890/);
  });

  it('kwota liczona w groszach bez błędu zmiennoprzecinkowego', () => {
    expect(ofertaNaProdukt({ id: '1', name: 'X', sellingMode: { price: { amount: '74.90', currency: 'PLN' } } }, KANAL, ['allegro_szkicownia', 'allegro_amarka']).cena_gr)
      .toBe(7490);
    expect(ofertaNaProdukt({ id: '1', name: 'X', sellingMode: { price: { amount: '0.07', currency: 'PLN' } } }, KANAL, ['allegro_szkicownia', 'allegro_amarka']).cena_gr)
      .toBe(7);
  });

  // ⚠️ ZMIERZONE w Zadaniu 0: Allegro oddaje kwote z JEDNYM miejscem po przecinku
  // („79.0", „28.9"), nie dwoma. Samo mnozenie daje 2890.0000000000005.
  it('kwota z jednym miejscem po przecinku (tak oddaje Allegro)', () => {
    expect(ofertaNaProdukt({ id: '1', name: 'X', sellingMode: { price: { amount: '79.0', currency: 'PLN' } } }, KANAL, ['allegro_szkicownia', 'allegro_amarka']).cena_gr)
      .toBe(7900);
    expect(ofertaNaProdukt({ id: '1', name: 'X', sellingMode: { price: { amount: '28.9', currency: 'PLN' } } }, KANAL, ['allegro_szkicownia', 'allegro_amarka']).cena_gr)
      .toBe(2890);
  });

  // ⚠️⚠️ `Math.round(Number(kwota) * 100)` — postac zapisana w planie — myli sie o GROSZ
  // w gore i w dol, bo mnozenie wykonuje sie na dwojkowym zmiennoprzecinkowym:
  //   Number('1.005') * 100 === 100.49999999999999  → Math.round daje 100, ma byc 101
  //   Number('2.675') * 100 === 267.49999999999994  → Math.round daje 267, ma byc 268
  // Jeden grosz na wierszu lustra nie boli sam w sobie — boli to, ze roznica jest
  // NIEPOWTARZALNA i widoczna dopiero przy porownaniu ceny z ta w sklepie. Przeliczenie
  // idzie po CYFRACH napisu, nie przez liczbe zmiennoprzecinkowa.
  it('kwota z trzecim miejscem po przecinku zaokrągla się arytmetycznie, nie zmiennoprzecinkowo', () => {
    expect(ofertaNaProdukt({ id: '1', name: 'X', sellingMode: { price: { amount: '1.005', currency: 'PLN' } } }, KANAL, ['allegro_szkicownia', 'allegro_amarka']).cena_gr)
      .toBe(101);
    expect(ofertaNaProdukt({ id: '1', name: 'X', sellingMode: { price: { amount: '2.675', currency: 'PLN' } } }, KANAL, ['allegro_szkicownia', 'allegro_amarka']).cena_gr)
      .toBe(268);
    // W dol tez, zeby zaokraglenie nie bylo zwyklym „zawsze w gore".
    expect(ofertaNaProdukt({ id: '1', name: 'X', sellingMode: { price: { amount: '1.004', currency: 'PLN' } } }, KANAL, ['allegro_szkicownia', 'allegro_amarka']).cena_gr)
      .toBe(100);
  });

  it('oferta bez ceny daje null, nie zero', () => {
    // ⚠️ 0 znaczyloby „za darmo" i wpadaloby w kazdy filtr ceny od zera w gore.
    expect(ofertaNaProdukt({ id: '1', name: 'X' }, KANAL, ['allegro_szkicownia', 'allegro_amarka']).cena_gr).toBe(null);
    expect(ofertaNaProdukt({ id: '1', name: 'X', sellingMode: {} }, KANAL, ['allegro_szkicownia', 'allegro_amarka']).cena_gr).toBe(null);
    expect(ofertaNaProdukt({ id: '1', name: 'X', sellingMode: { price: {} } }, KANAL, ['allegro_szkicownia', 'allegro_amarka']).cena_gr).toBe(null);
    expect(ofertaNaProdukt({ id: '1', name: 'X', sellingMode: { price: { amount: null, currency: 'PLN' } } }, KANAL, ['allegro_szkicownia', 'allegro_amarka']).cena_gr).toBe(null);
  });

  // ⚠️⚠️ TO SA PIENIADZE I KOLUMNA `INTEGER`. Kwota, ktorej nie umiemy przeliczyc, nie ma
  // prawa wpasc do bazy ani jako napis (psuje filtr ceny w calym magazynie — porownanie
  // napisu z liczba w SQLite jest zawsze falszywe), ani jako NaN, ani jako ciche zero.
  // „Brak ceny" (test wyzej) i „cena, ktorej nie rozumiem" to DWA ROZNE stany.
  it('kwota nie do przeliczenia wywala odczyt GŁOŚNO, zamiast wpaść do kolumny INTEGER', () => {
    const zKwota = (amount) => () => ofertaNaProdukt(
      { id: '1234567890', name: 'X', sellingMode: { price: { amount, currency: 'PLN' } } }, KANAL,
     ['allegro_szkicownia', 'allegro_amarka']);
    // Przecinek dziesietny — najbardziej prawdopodobna zmiana po stronie Allegro.
    expect(zKwota('89,00')).toThrow(/89,00/);
    expect(zKwota('')).toThrow(/kwot/i);
    expect(zKwota('  ')).toThrow(/kwot/i);
    expect(zKwota('brak')).toThrow(/kwot/i);
    expect(zKwota('89.00 PLN')).toThrow(/kwot/i);
    expect(zKwota(Number.NaN)).toThrow(/kwot/i);
    expect(zKwota(Number.POSITIVE_INFINITY)).toThrow(/kwot/i);
    expect(zKwota({ amount: '89.00' })).toThrow(/kwot/i);
    expect(zKwota(['89.00'])).toThrow(/kwot/i);
    expect(zKwota(true)).toThrow(/kwot/i);
    // Ujemna cena nie istnieje na Allegro; w kolumnie pieniedzy znaczylaby usterke,
    // ktora rozejdzie sie po raportach.
    expect(zKwota('-5.00')).toThrow(/kwot/i);
    // Komunikat ma nazwac ofertę — inaczej „zla kwota" w przebiegu po 447 ofertach
    // nie mowi, ktora z nich obejrzec.
    expect(zKwota('89,00')).toThrow(/1234567890/);
    // ⚠️ …I MA NAZWAC ZRODLO. Od Zadania 7 samo przeliczenie kwoty jest WSPOLNE ze sklepami
    // (`domain/kwota.js`), bo obie ceny lada w tej samej kolumnie `cena_gr`. Sam tekst
    // „nie umiem przeliczyć kwoty" nie mowi juz przez to, ktory z czterech kanalow sie
    // wysypal — a odczyt magazynu chodzi po wszystkich naraz i to ten komunikat laduje
    // na ekranie przy kanale.
    expect(zKwota('89,00')).toThrow(/Allegro/);
  });

  // Kwota LICZBA (gdyby Allegro przestalo oddawac napis) jest przeliczalna i przechodzi —
  // to nie jest ten sam przypadek, co smiec. Para do testu wyzej: straznik ma MILCZEC
  // na wszystkim, co da sie policzyc dokladnie.
  it('kwota, którą da się przeliczyć, przechodzi bez słowa', () => {
    expect(ofertaNaProdukt({ id: '1', name: 'X', sellingMode: { price: { amount: 89, currency: 'PLN' } } }, KANAL, ['allegro_szkicownia', 'allegro_amarka']).cena_gr).toBe(8900);
    expect(ofertaNaProdukt({ id: '1', name: 'X', sellingMode: { price: { amount: 28.9, currency: 'PLN' } } }, KANAL, ['allegro_szkicownia', 'allegro_amarka']).cena_gr).toBe(2890);
    expect(ofertaNaProdukt({ id: '1', name: 'X', sellingMode: { price: { amount: '0.00', currency: 'PLN' } } }, KANAL, ['allegro_szkicownia', 'allegro_amarka']).cena_gr).toBe(0);
    expect(ofertaNaProdukt({ id: '1', name: 'X', sellingMode: { price: { amount: ' 89.00 ', currency: 'PLN' } } }, KANAL, ['allegro_szkicownia', 'allegro_amarka']).cena_gr).toBe(8900);
  });

  // ⚠️⚠️ WALUTA. `produkty_sklepowe.cena_gr` to goly INTEGER i kolumny waluty NIE MA, wiec
  // oferta w EUR wpadalaby do lustra jako te same 8900 groszy, co oferta za 89 zl — czyli
  // wygladalaby na ~4× tansza od tego samego produktu w sklepie, CICHO. Zmierzone przy recenzji:
  // 'EUR', 'CZK' i brak pola dawaly identyczny wynik co 'PLN'.
  //
  // Odmowa NIE jest sadem o EUR, tylko o kolumnie: skoro schemat waluty nie utrzyma, zapis
  // bylby klamstwem. To domyka niespojnosc — przecinek dziesietny i wartosc ujemna
  // odrzucalismy glosno, a nieznana walute przyjmowalismy bez slowa.
  it('cena w walucie innej niż PLN wywala odczyt, bo kolumna waluty nie niesie', () => {
    const zWaluta = (currency) => () => ofertaNaProdukt(
      { id: '1234567890', name: 'X', sellingMode: { price: { amount: '89.00', currency } } }, KANAL,
     ['allegro_szkicownia', 'allegro_amarka']);
    expect(zWaluta('EUR')).toThrow(/EUR/);
    // AmarkaPL sprzedaje na piec rynkow (allegro-cz, -sk, -hu) — to nie jest przypadek
    // teoretyczny, tylko jedna zmiana po stronie Allegro.
    expect(zWaluta('CZK')).toThrow(/CZK/);
    // Komunikat ma nazwac oferte i powiedziec, czego oczekiwalismy.
    expect(zWaluta('EUR')).toThrow(/1234567890/);
    expect(zWaluta('EUR')).toThrow(/PLN/);
  });

  // ⚠️ Brak waluty i waluta nie-napis wpadaja w ten sam warunek SWIADOMIE: waluty, ktorej nie
  // da sie zweryfikowac, nie wolno zgadywac na „pewnie PLN". Bez tego przypadku straznik
  // przepuszczajacy `undefined` (najczestszy ksztalt bledu) przechodzilby na zielono.
  it('cena BEZ waluty też wywala odczyt — waluty się nie zgaduje', () => {
    const zCena = (price) => () => ofertaNaProdukt({ id: '1234567890', name: 'X', sellingMode: { price } }, KANAL, ['allegro_szkicownia', 'allegro_amarka']);
    expect(zCena({ amount: '89.00' })).toThrow(/walu/i);
    expect(zCena({ amount: '89.00', currency: null })).toThrow(/walu/i);
    expect(zCena({ amount: '89.00', currency: 985 })).toThrow(/walu/i);
    expect(zCena({ amount: '89.00', currency: 'pln' })).toThrow(/walu/i);
  });

  // ⚠️ KOLEJNOSC STRAZNIKOW JEST TRESCIA, NIE UKLADEM. Gdy zle jest OBOJE, mowimy o walucie:
  // czlowiek czytajacy „nie umiem przeliczyć kwoty" poszedlby poprawiac parser kwot, podczas
  // gdy prawdziwy powod brzmi „ta oferta jest w euro, a lustro trzyma tylko złotówki".
  // Straznik waluty przeniesiony ZA przeliczenie przechodzil bez tego testu (mutacja R5).
  it('gdy zła jest i waluta, i kwota — komunikat mówi o WALUCIE', () => {
    expect(() => ofertaNaProdukt(
      { id: '1234567890', name: 'X', sellingMode: { price: { amount: 'brak', currency: 'EUR' } } }, KANAL,
     ['allegro_szkicownia', 'allegro_amarka'])).toThrow(/walu/i);
    expect(() => ofertaNaProdukt(
      { id: '1234567890', name: 'X', sellingMode: { price: { amount: 'brak', currency: 'EUR' } } }, KANAL,
     ['allegro_szkicownia', 'allegro_amarka'])).not.toThrow(/nie umiem przeliczyć/);
  });

  // ⚠️ PARA DO OBU TESTOW WYZEJ: straznik ma MILCZEC, gdy waluta jest wlasciwa, ORAZ nie ma
  // prawa ruszyc sciezki „ceny w ogole nie ma" — tam waluty nie ma czego pilnowac i `null`
  // zostaje `null`. Bez tego straznik zaostrzony do „kazda oferta musi miec walute"
  // wywalilby odczyt na kazdej ofercie bez ceny.
  it('PLN przechodzi bez słowa, a brak ceny w ogóle nie pyta o walutę', () => {
    expect(ofertaNaProdukt(oferta(), KANAL, ['allegro_szkicownia', 'allegro_amarka']).cena_gr).toBe(8900);
    expect(ofertaNaProdukt({ id: '1', name: 'X' }, KANAL, ['allegro_szkicownia', 'allegro_amarka']).cena_gr).toBe(null);
    expect(ofertaNaProdukt({ id: '1', name: 'X', sellingMode: { price: {} } }, KANAL, ['allegro_szkicownia', 'allegro_amarka']).cena_gr).toBe(null);
    expect(ofertaNaProdukt({ id: '1', name: 'X', sellingMode: { price: { amount: null } } }, KANAL, ['allegro_szkicownia', 'allegro_amarka']).cena_gr).toBe(null);
  });

  // ⚠️ Bez tego oferta zakonczona udaje zywa — i wchodzi do generatora SKU oraz na liste
  // „do powiazania" na rowni ze sprzedawana. Pole ZMIERZONE w Zadaniu 0.
  it('przepisuje stan publikacji oferty', () => {
    expect(ofertaNaProdukt({
      id: '1', name: 'X', sellingMode: { price: { amount: '1.0', currency: 'PLN' } },
      publication: { status: 'ACTIVE' },
    }, KANAL, ['allegro_szkicownia', 'allegro_amarka']).status_publikacji).toBe('ACTIVE');
    expect(ofertaNaProdukt({
      id: '1', name: 'X', sellingMode: { price: { amount: '1.0', currency: 'PLN' } },
      publication: { status: 'ENDED' },
    }, KANAL, ['allegro_szkicownia', 'allegro_amarka']).status_publikacji).toBe('ENDED');
  });

  it('brak publication daje null, a nie undefined', () => {
    const p = ofertaNaProdukt({ id: '1', name: 'X', sellingMode: { price: { amount: '1.0', currency: 'PLN' } } }, KANAL, ['allegro_szkicownia', 'allegro_amarka']);
    expect(p.status_publikacji).toBe(null);
    expect(p.status_publikacji).not.toBeUndefined();
  });

  // ⚠️ JEDEN ELEMENT I TO WYSTARCZA. Lista ofert niesie wylacznie `primaryImage`, a pelna
  // galeria kosztowalaby 447 osobnych wywolan `/sale/product-offers/{id}`. Zdjecia do karty
  // produktu i tak bierzemy ze SKLEPU, gdzie Woo oddaje komplet za darmo.
  it('zdjęcia to tablica JSON z jednym adresem — dokładnie tym, co przyszło', () => {
    const p = ofertaNaProdukt(oferta(), KANAL, ['allegro_szkicownia', 'allegro_amarka']);
    expect(JSON.parse(p.zdjecia_json)).toEqual(['https://a.allegroimg.com/original/aaa/bbb']);
  });

  it('brak zdjęcia głównego daje null, a nie pustą tablicę w JSON-ie', () => {
    expect(ofertaNaProdukt(oferta({ primaryImage: undefined }), KANAL, ['allegro_szkicownia', 'allegro_amarka']).zdjecia_json).toBe(null);
    expect(ofertaNaProdukt(oferta({ primaryImage: {} }), KANAL, ['allegro_szkicownia', 'allegro_amarka']).zdjecia_json).toBe(null);
    expect(ofertaNaProdukt(oferta({ primaryImage: { url: '   ' } }), KANAL, ['allegro_szkicownia', 'allegro_amarka']).zdjecia_json).toBe(null);
  });

  // Ten adres laduje wprost w atrybucie `src` naszego HTML-a (ta sama regula, co
  // w domain/miniatury.js). Allegro jest zrodlem zaufanym, ale wpuszczanie tam czegokolwiek
  // poza http(s) nie ma uzasadnienia i kosztuje jedna linie.
  it('adres zdjęcia inny niż http(s) nie trafia do lustra', () => {
    expect(ofertaNaProdukt(oferta({ primaryImage: { url: 'javascript:alert(1)' } }), KANAL, ['allegro_szkicownia', 'allegro_amarka']).zdjecia_json).toBe(null);
    expect(ofertaNaProdukt(oferta({ primaryImage: { url: '/original/aaa' } }), KANAL, ['allegro_szkicownia', 'allegro_amarka']).zdjecia_json).toBe(null);
  });

  // ⚠️ Rozmiar jest w nazwie tylko w ~40% ofert (zmierzone w Zadaniu 0), a `wymiaryZTekstu`
  // NIGDY nie zgaduje. Do lustra idzie CALA nazwa jako tekst zrodlowy rozmiaru — wyprowadzenie
  // milimetrow jest osobna regula i osobnym krokiem.
  it('rozmiar_tekst to nazwa oferty, bo Allegro nie ma osobnego pola rozmiaru', () => {
    const p = ofertaNaProdukt(oferta({ name: 'Kopuła - lampa wisząca do kuchni nad stół, klosz 60cm' }), KANAL, ['allegro_szkicownia', 'allegro_amarka']);
    expect(p.rozmiar_tekst).toBe('Kopuła - lampa wisząca do kuchni nad stół, klosz 60cm');
    expect(p.rozmiar_tekst).toBe(p.nazwa);
  });

  // ⚠️ NIEZMIENNIK 8: magazyn NIE PROWADZI STANOW MAGAZYNOWYCH. `stock.available` jest
  // w odpowiedzi (zmierzone: 490, 15) i jest kuszacy — a raz zapisany stan zaczyna byc
  // czytany jako prawda, mimo ze odswieza sie wylacznie przyciskiem.
  it('oddaje DOKŁADNIE kolumny lustra i ani jednej więcej — bez stanów magazynowych', () => {
    const p = ofertaNaProdukt(oferta({ stock: { available: 490, sold: 12 }, stats: { watchersCount: 3 } }), KANAL, ['allegro_szkicownia', 'allegro_amarka']);
    expect(Object.keys(p).sort()).toEqual([
      'adres', 'cena_gr', 'kanal', 'miniatura', 'nazwa', 'produkt_id', 'rozmiar_tekst',
      'sku_sklepu', 'status_publikacji', 'wariant_id', 'zdjecia_json',
    ]);
  });

  // Regula jest CZYSTA — mieszka w domain/ wlasnie po to, zeby dalo sie ja sprawdzic bez
  // sieci. Mapowanie, ktore dopisuje cokolwiek do wejscia, rozjechaloby odczyt z tym,
  // co Allegro naprawde przyslalo.
  it('nie tyka obiektu wejściowego', () => {
    const wejscie = oferta();
    const kopia = structuredClone(wejscie);
    ofertaNaProdukt(wejscie, KANAL, ['allegro_szkicownia', 'allegro_amarka']);
    expect(wejscie).toEqual(kopia);
  });
});

// =======================================================================================
// KLIENT — `pobierzOferty`. Stronicowanie `limit`/`offset`, odpowiedz `{count, offers,
// totalCount}` (ksztalt ZMIERZONY w Zadaniu 0, nie wziety z dokumentacji).
// =======================================================================================

const tokeny = { waznyToken: async () => 'TOKEN' };
// ⚠️ WARTOSC JAWNIE FIKCYJNA — prawdziwy naglowek jest w konfiguracji (`ALLEGRO_USER_AGENT`),
// bo Allegro trzyma go na bialej liscie. `.invalid` to TLD zarezerwowane przez RFC 2606.
const UA = 'PrzykladowyPanel/0.0.0 (+https://przyklad.invalid/panel)';
const ustawienia = { api: 'https://api.przyklad', userAgent: UA };

const klient = (fetchImpl, u = ustawienia) => createAllegroClient({ ustawienia: u, tokeny, fetchImpl });

// Atrapa konta Allegro: odpowiedz zalezy od `offset` i `limit` Z ZADANIA, wiec test widzi
// takze to, czego klient NIE dopisal do zadania o strone 5.
function kontoZOfertami(ile, { totalCount = ile } = {}) {
  return vi.fn().mockImplementation(async (url) => {
    const p = new URL(url).searchParams;
    const offset = Number(p.get('offset'));
    const limit = Number(p.get('limit'));
    const ilePartii = Math.max(0, Math.min(limit, ile - offset));
    const offers = Array.from({ length: ilePartii }, (_, i) => ({ id: String(offset + i + 1) }));
    return { ok: true, status: 200, json: async () => ({ count: offers.length, offers, totalCount }) };
  });
}

// Konto BEZ DNA: kazda strona pelna, `totalCount` zawyzony w kosmos — dokladnie tak wyglada
// zapetlone stronicowanie i zle policzony licznik po stronie Allegro.
//
// ⚠️ ATRAPA SAMA ODMAWIA po przekroczeniu granicy, i to jest istotne. Bez tego klient
// pozbawiony twardej granicy zbiera oferty w nieskonczonosc, a test konczy sie ZJEDZENIEM
// PAMIECI procesu (zmierzone: „JavaScript heap out of memory", worker pada po 41 s i nie
// raportuje ani jednego przypadku). Wykrycie przez OOM jest wykryciem pozornym — pada CALY
// plik, a komunikat nie mowi o co chodzi. Odmowa atrapy zamienia to w czytelna czerwien.
const kontoBezDna = () => vi.fn().mockImplementation(async (url) => {
  const offset = Number(new URL(url).searchParams.get('offset'));
  const ktoreZadanie = offset / LIMIT_STRONY_OFERT + 1;
  if (ktoreZadanie > MAKS_STRON_OFERT) {
    throw new Error(`ATRAPA ODMAWIA: to juz ${ktoreZadanie}. wywolanie — klient nie ma twardej granicy`);
  }
  const offers = Array.from({ length: LIMIT_STRONY_OFERT }, (_, i) => ({ id: String(offset + i + 1) }));
  return { ok: true, status: 200, json: async () => ({ count: offers.length, offers, totalCount: 1e9 }) };
});

const odpowiedz = (cialo) => ({ ok: true, status: 200, json: async () => cialo });

// Parametry KAZDEGO zadania. Asercja po `calls[0]` przepuszcza klienta, ktory dokleja
// cokolwiek tylko do pierwszej strony (lekcja z Zadania 5).
const parametryWywolan = (fetchImpl) => fetchImpl.mock.calls.map(([url]) => new URL(url).searchParams);

describe('pobierzOferty — stronicowanie', () => {
  it('pyta /sale/offers z limitem i offsetem od zera', async () => {
    const fetchImpl = kontoZOfertami(3);
    const oferty = await klient(fetchImpl).pobierzOferty();

    expect(fetchImpl).toHaveBeenCalledTimes(1);
    expect(fetchImpl.mock.calls[0][0]).toContain('https://api.przyklad/sale/offers?');
    expect(parametryWywolan(fetchImpl)[0].get('limit')).toBe(String(LIMIT_STRONY_OFERT));
    expect(parametryWywolan(fetchImpl)[0].get('offset')).toBe('0');
    expect(oferty).toHaveLength(3);
  });

  // ⚠️ `GET /sale/offers/{id}` Allegro WYCOFALO (403 „no longer supported"), ale LISTA
  // `/sale/offers` dziala — zmierzone 2026-08-06, HTTP 200. Szczegoly jednej oferty ida
  // przez `/sale/product-offers/{id}` (pobierzOferte) i to JEST inny zasob: pomylka tutaj
  // wycisza caly odczyt magazynu z Allegro.
  it('lista ofert NIE idzie przez /sale/product-offers', async () => {
    const fetchImpl = kontoZOfertami(45);
    await klient(fetchImpl).pobierzOferty();
    for (const [url] of fetchImpl.mock.calls) {
      expect(new URL(url).pathname).toBe('/sale/offers');
    }
  });

  it('chodzi po stronach, aż zbierze tyle, ile zapowiedział totalCount', async () => {
    const fetchImpl = kontoZOfertami(447);
    const oferty = await klient(fetchImpl).pobierzOferty();

    expect(oferty).toHaveLength(447);
    expect(oferty.at(-1).id).toBe('447');
    expect(fetchImpl).toHaveBeenCalledTimes(Math.ceil(447 / LIMIT_STRONY_OFERT));
  });

  // Sama liczba wywolan nie wystarcza: klient pytajacy dwa razy o offset 0 przeszedlby
  // tamten test i po cichu zgubil polowe katalogu (dostalby duplikaty).
  it('kolejne żądania niosą kolejne offsety, po pełnym limicie', async () => {
    const fetchImpl = kontoZOfertami(3 * LIMIT_STRONY_OFERT);
    await klient(fetchImpl).pobierzOferty();

    expect(parametryWywolan(fetchImpl).map((p) => p.get('offset')))
      .toEqual(['0', String(LIMIT_STRONY_OFERT), String(2 * LIMIT_STRONY_OFERT)]);
  });

  it('limit jedzie na KAŻDEJ stronie, nie tylko na pierwszej', async () => {
    const fetchImpl = kontoZOfertami(447);
    await klient(fetchImpl).pobierzOferty();

    const limity = parametryWywolan(fetchImpl).map((p) => p.get('limit'));
    expect(limity).toHaveLength(Math.ceil(447 / LIMIT_STRONY_OFERT));
    expect(limity).toEqual(limity.map(() => String(LIMIT_STRONY_OFERT)));
  });

  // ⚠️ ZMIERZONE 2026-08-04: literowka w nazwie parametru jest przez Allegro CICHO
  // IGNOROWANA — odpowiedz wyglada poprawnie, tylko jest szersza. Zapytanie ma wiec
  // niesc DOKLADNIE dwa parametry; kazdy nadmiarowy jest albo bez znaczenia (i wtedy
  // nie ma po co go wysylac), albo filtruje — i wtedy jest decyzja, nie detalem.
  it('żądanie niesie WYŁĄCZNIE limit i offset — żadnych cicho ignorowanych filtrów', async () => {
    const fetchImpl = kontoZOfertami(45);
    await klient(fetchImpl).pobierzOferty();

    for (const p of parametryWywolan(fetchImpl)) {
      expect([...p.keys()].sort()).toEqual(['limit', 'offset']);
    }
  });

  it('limit strony mieści się w tym, co Allegro przyjmuje', () => {
    expect(LIMIT_STRONY_OFERT).toBeGreaterThan(0);
    expect(LIMIT_STRONY_OFERT).toBeLessThanOrEqual(100);
  });

  it('surowe oferty oddaje bez tknięcia — mapowanie to nie jest robota klienta', async () => {
    const surowa = oferta({ stock: { available: 490 } });
    const fetchImpl = vi.fn().mockResolvedValue(odpowiedz({ count: 1, offers: [surowa], totalCount: 1 }));

    expect(await klient(fetchImpl).pobierzOferty()).toEqual([surowa]);
  });

  // 200 z cialem, ktore NIE jest lista ofert, wygladaloby jak „konto nie ma nic" — a wtedy
  // Zadanie 7 oznaczyloby CALY katalog kanalu jako znikniety.
  it('200 z ciałem nie-tablicą NIE MOŻE udawać „brak ofert”', async () => {
    const fetchImpl = vi.fn().mockResolvedValue(odpowiedz({ count: 0, offers: null, totalCount: 0 }));
    await expect(klient(fetchImpl).pobierzOferty()).rejects.toThrow(/nie oddało listy ofert/);
  });

  it('brak pola offers też jest błędem, a nie pustką', async () => {
    const fetchImpl = vi.fn().mockResolvedValue(odpowiedz({ totalCount: 447 }));
    await expect(klient(fetchImpl).pobierzOferty()).rejects.toThrow(/nie oddało listy ofert/);
  });

  // Konto bez ofert to stan NORMALNY (nowe konto), a nie awaria — pusta TABLICA jest
  // czym innym niz brak tablicy.
  it('pusta lista ofert przechodzi i nie kręci się w kółko', async () => {
    const fetchImpl = vi.fn().mockResolvedValue(odpowiedz({ count: 0, offers: [], totalCount: 0 }));
    await expect(klient(fetchImpl).pobierzOferty()).resolves.toEqual([]);
    expect(fetchImpl).toHaveBeenCalledTimes(1);
  });

  // Bez totalCount konczymy na stronie krotszej niz limit — inaczej odczyt nie mialby
  // ZADNEGO warunku stopu poza twarda granica stron.
  it('brak totalCount → koniec na stronie krótszej niż limit', async () => {
    const fetchImpl = vi.fn()
      .mockResolvedValueOnce(odpowiedz({ offers: Array.from({ length: LIMIT_STRONY_OFERT }, (_, i) => ({ id: String(i) })) }))
      .mockResolvedValueOnce(odpowiedz({ offers: [{ id: 'ostatnia' }] }));

    const oferty = await klient(fetchImpl).pobierzOferty();

    expect(oferty).toHaveLength(LIMIT_STRONY_OFERT + 1);
    expect(fetchImpl).toHaveBeenCalledTimes(2);
  });

  // ⚠️ Bez tego konto zglaszajace absurdalny `totalCount` (albo oddajace w kolko pelna
  // strone) zapetliloby odczyt na godziny — przycisk „Odswiez", ktory nigdy nie wraca.
  it('ma twardą granicę stron i nie kręci się w nieskończoność', async () => {
    const fetchImpl = kontoBezDna();
    // Odmowa ma przyjsc OD KLIENTA (słowo „stron"), a nie od atrapy — i po dokladnie
    // tylu zadaniach, ile wolno.
    await expect(klient(fetchImpl).pobierzOferty()).rejects.toThrow(/stron/i);
    expect(fetchImpl).toHaveBeenCalledTimes(MAKS_STRON_OFERT);
  });

  it('komunikat granicy podaje, ile stron wolno przeczytać', async () => {
    const fetchImpl = kontoBezDna();
    const blad = await klient(fetchImpl).pobierzOferty().catch((e) => e);
    expect(blad.message).toContain(String(MAKS_STRON_OFERT));
    expect(blad.message).not.toContain('ATRAPA');
  });

  // Granica ma chronic przed absurdem, a nie ucinac prawdziwe konto: 447 ofert szkicownia_pl
  // ma przejsc w calosci, z zapasem.
  it('granica stron mieści oba prawdziwe konta z zapasem', () => {
    expect(MAKS_STRON_OFERT * LIMIT_STRONY_OFERT).toBeGreaterThan(4 * 447);
  });
});

// ⚠️ Uciety odczyt (Allegro urwalo strone, proxy zjadlo odpowiedz) WYGLADA JAK SUKCES,
// a potem Zadanie 7 oznacza brakujace oferty jako `zniknal_at` — czyli jest nieodrozninalny
// od „konto stracilo pol katalogu". Ta sama dyscyplina, co przy Woo w Zadaniu 5.
describe('pobierzOferty — kontrola kompletności po totalCount', () => {
  it('zebranie mniej ofert, niż zapowiedziało Allegro, to błąd', async () => {
    const fetchImpl = vi.fn().mockResolvedValue(odpowiedz({ count: 2, offers: [{ id: '1' }, { id: '2' }], totalCount: 447 }));
    await expect(klient(fetchImpl).pobierzOferty()).rejects.toThrow(/447/);
  });

  it('komunikat podaje obie liczby: ile zapowiedziano i ile zebrano', async () => {
    const fetchImpl = vi.fn().mockResolvedValue(odpowiedz({ count: 2, offers: [{ id: '1' }, { id: '2' }], totalCount: 447 }));
    const blad = await klient(fetchImpl).pobierzOferty().catch((e) => e);
    expect(blad.message).toContain('447');
    expect(blad.message).toContain('2');
  });

  // ⚠️⚠️ NAJWAZNIEJSZY TEST TEJ KONTROLI: jedyny, w ktorym ma ona PRZEJSC przy wielu
  // stronach. Bez niego straznik PRZENIESIONY DO WNETRZA PETLI (a nie usuniety!) przechodzi
  // cala suite na zielono, a na prawdziwym koncie wywala sie po pierwszej stronie — bo
  // zebrane 20 zawsze jest mniejsze od zapowiedzianych 447. Magazyn nie wczytalby ANI
  // JEDNEJ oferty. Ta sama dziura kosztowala runde recenzji w Zadaniu 5.
  it('447 ofert zapowiedzianych i zebranych na 23 stronach przechodzi w całości', async () => {
    const fetchImpl = kontoZOfertami(447);

    const oferty = await klient(fetchImpl).pobierzOferty();

    expect(oferty).toHaveLength(447);
    expect(fetchImpl).toHaveBeenCalledTimes(Math.ceil(447 / LIMIT_STRONY_OFERT));
  });

  // ⚠️⚠️ GRANICA PRZYPIETA CO DO JEDNEGO. Recenzja zmierzyla: `wszystkie.length < zapowiedziano`
  // podmienione na `wszystkie.length + 1 < zapowiedziano` przechodzilo 56/56 na zielono —
  // testy pilnowaly 2 wobec 447 i 447 wobec 447, czyli obu koncow, ale nie SAMEJ GRANICY.
  //
  // Scenariusz, ktory to ucisza, jest zwyczajny: Allegro zapowiada 447, jedna oferta konczy
  // sie w trakcie 23-zadaniowego odczytu, zbieramy 446. Alarm milknie, Zadanie 7 uznaje liste
  // za kompletna i oznacza te oferte `zniknal_at`. Jeden widmowy wiersz zamiast katalogu — ale
  // to jest DOKLADNIE ten przypadek, ktory wybralismy jako glosny („wolimy glosny falszywy
  // alarm od cichej straty"), wiec ma sie odzywac.
  it('JEDNA oferta mniej, niż zapowiedziano, to już błąd', async () => {
    const fetchImpl = kontoZOfertami(446, { totalCount: 447 });
    const blad = await klient(fetchImpl).pobierzOferty().catch((e) => e);
    expect(blad).toBeInstanceOf(Error);
    expect(blad.message).toContain('447');
    expect(blad.message).toContain('446');
  });

  it('29 ofert drugiego konta (dwie strony) też przechodzi bez słowa', async () => {
    const fetchImpl = kontoZOfertami(29);
    await expect(klient(fetchImpl).pobierzOferty()).resolves.toHaveLength(29);
  });

  // Oferta wystawiona w trakcie odczytu dokłada się do liczby. Falszywy alarm bylby tu
  // gorszy niz cisza: nic nie ginie.
  it('więcej niż zapowiedziano → przechodzi bez słowa', async () => {
    const fetchImpl = vi.fn().mockResolvedValue(odpowiedz({ count: 3, offers: [{ id: '1' }, { id: '2' }, { id: '3' }], totalCount: 2 }));
    await expect(klient(fetchImpl).pobierzOferty()).resolves.toHaveLength(3);
  });

  it('brak totalCount → kontrola pominięta, odczyt przechodzi', async () => {
    const fetchImpl = vi.fn().mockResolvedValue(odpowiedz({ offers: [{ id: '1' }] }));
    await expect(klient(fetchImpl).pobierzOferty()).resolves.toHaveLength(1);
  });

  it('totalCount, który nie jest liczbą, też pomija kontrolę zamiast wywracać odczyt', async () => {
    const fetchImpl = vi.fn().mockResolvedValue(odpowiedz({ offers: [{ id: '1' }], totalCount: 'dużo' }));
    await expect(klient(fetchImpl).pobierzOferty()).resolves.toHaveLength(1);
  });

  // ⚠️ Oczekiwana liczba pochodzi z PIERWSZEJ odpowiedzi. Klient czytajacy ja z ostatniej
  // stracilby kontrole dokladnie w tym scenariuszu, przed ktorym ma bronic: gdy Allegro
  // przestaje oddawac `totalCount` w trakcie odczytu.
  it('oczekiwaną liczbę bierze z pierwszej odpowiedzi, nie z ostatniej', async () => {
    const pelna = Array.from({ length: LIMIT_STRONY_OFERT }, (_, i) => ({ id: String(i + 1) }));
    const fetchImpl = vi.fn()
      .mockResolvedValueOnce(odpowiedz({ count: pelna.length, offers: pelna, totalCount: 250 }))
      .mockResolvedValueOnce(odpowiedz({ count: 0, offers: [] }));

    await expect(klient(fetchImpl).pobierzOferty()).rejects.toThrow(/250/);
  });

  // Pusta strona konczy odczyt, cokolwiek mowi `totalCount` — inaczej Allegro z zawyzona
  // liczba trzymaloby petle az do twardej granicy stron. Odczyt urywa sie wtedy GLOSNO,
  // na kontroli kompletnosci, a nie po cichu.
  it('pusta strona przerywa pętlę, a niekompletność wychodzi błędem', async () => {
    const pelna = Array.from({ length: LIMIT_STRONY_OFERT }, (_, i) => ({ id: String(i + 1) }));
    const fetchImpl = vi.fn()
      .mockResolvedValueOnce(odpowiedz({ count: pelna.length, offers: pelna, totalCount: 447 }))
      .mockResolvedValue(odpowiedz({ count: 0, offers: [], totalCount: 447 }));

    await expect(klient(fetchImpl).pobierzOferty()).rejects.toThrow(/447/);
    expect(fetchImpl).toHaveBeenCalledTimes(2);
  });
});

describe('pobierzOferty — nagłówki, metoda i limit czasu', () => {
  // ⚠️⚠️ Allegro pisze wprost: wywolania bez prawidlowego `User-Agent` spowoduja
  // ZABLOKOWANIE KLUCZA API, a po 30.06.2026 sa odrzucane automatycznie. Odczyt ofert to
  // 23 zadania pod rzad — naglowek doklejony tylko do pierwszego to 22 zadania niezgodne.
  it('KAŻDA strona niesie User-Agent z konfiguracji, Accept i token', async () => {
    const fetchImpl = kontoZOfertami(447);
    await klient(fetchImpl).pobierzOferty();

    const naglowki = fetchImpl.mock.calls.map(([, opcje]) => opcje.headers);
    expect(naglowki).toHaveLength(Math.ceil(447 / LIMIT_STRONY_OFERT));
    for (const h of naglowki) {
      expect(h['User-Agent']).toBe(UA);
      expect(h.Accept).toBe('application/vnd.allegro.public.v1+json');
      expect(h.Authorization).toBe('Bearer TOKEN');
    }
  });

  // ⚠️ TEST NA „STALA W KODZIE". Test wyzej przeszedlby tak samo, gdyby ktos wpisal naglowek
  // na sztywno — a Allegro pozwala zmieniac w nim WYLACZNIE numer wersji (biala lista),
  // wiec wartosc ma isc z `.env.oms`, a nie z wydania panelu.
  it('User-Agent pochodzi z ustawień kanału, a nie ze stałej w module', async () => {
    const fetchImpl = kontoZOfertami(45);
    const inny = { ...ustawienia, userAgent: 'InnaNazwa/9.9.9 (+https://inny.invalid/dok)' };
    await klient(fetchImpl, inny).pobierzOferty();

    for (const [, opcje] of fetchImpl.mock.calls) {
      expect(opcje.headers['User-Agent']).toBe('InnaNazwa/9.9.9 (+https://inny.invalid/dok)');
      expect(opcje.headers['User-Agent']).not.toBe(UA);
    }
  });

  // Odczyt magazynu NIE MA PRAWA niczego zmienic na koncie sprzedazowym.
  it('każda strona jest GET-em i nie niesie ciała', async () => {
    const fetchImpl = kontoZOfertami(45);
    await klient(fetchImpl).pobierzOferty();

    expect(fetchImpl.mock.calls.length).toBeGreaterThan(1);
    for (const [, opcje] of fetchImpl.mock.calls) {
      expect(opcje.method ?? 'GET').toBe('GET');
      expect(opcje.body).toBeUndefined();
    }
  });

  // Access token zyje ~12 h, a odczyt 447 ofert to 23 zadania pod rzad — token zapamietany
  // raz na cale wywolanie zamienilby sie w 401 w srodku przebiegu.
  it('token bierze świeżo do każdej strony', async () => {
    let ile = 0;
    const fetchImpl = kontoZOfertami(3 * LIMIT_STRONY_OFERT);
    const k = createAllegroClient({
      ustawienia,
      tokeny: { waznyToken: async () => { ile += 1; return `T${ile}`; } },
      fetchImpl,
    });

    await k.pobierzOferty();

    expect(ile).toBe(3);
    expect(fetchImpl.mock.calls.map(([, o]) => o.headers.Authorization))
      .toEqual(['Bearer T1', 'Bearer T2', 'Bearer T3']);
  });

  it('błąd HTTP wywala głośno, ale NIE wypisuje tokenu (niezmiennik 4.10)', async () => {
    const sekret = 'SEKRETNY-ACCESS-TOKEN-9f8e7d';
    const fetchImpl = vi.fn().mockResolvedValue({ ok: false, status: 403, json: async () => ({ error: sekret }) });
    const k = createAllegroClient({ ustawienia, tokeny: { waznyToken: async () => sekret }, fetchImpl });

    const blad = await k.pobierzOferty().catch((e) => e);
    expect(blad).toBeInstanceOf(Error);
    expect(blad.message).toContain('403');
    expect(blad.message).toContain('/sale/offers');
    expect(blad.message).not.toContain(sekret);
  });

  // ⚠️ Bez wlasnego sygnalu undici czeka na naglowki 300 000 ms, a serwer panelu stoi
  // z `requestTimeout: 0`. Tu limit MNOZY SIE przez liczbe stron (23 przy 447 ofertach),
  // wiec milczace Allegro bez limitu to przycisk „Odswiez", ktory nie wraca nigdy.
  const wiszacyFetch = vi.fn().mockImplementation((url, opcje = {}) => new Promise((_, odrzuc) => {
    if (!opcje.signal) return;
    opcje.signal.addEventListener('abort', () => odrzuc(opcje.signal.reason));
  }));

  it('milczące Allegro KOŃCZY odczyt ofert błędem po limicie, zamiast wisieć', async () => {
    const oryginalna = AbortSignal.timeout.bind(AbortSignal);
    const zadaneLimity = [];
    const szpieg = vi.spyOn(AbortSignal, 'timeout').mockImplementation((ms) => {
      zadaneLimity.push(ms);
      // Prawdziwy sygnal, tylko SKROCONY — inaczej test czekalby tyle, co produkcja.
      return oryginalna(20);
    });
    try {
      const blad = await klient(wiszacyFetch).pobierzOferty().then(() => null, (e) => e);
      expect(blad).toBeTruthy();
      expect(blad.name).toBe('TimeoutError');
      // Sam fakt „jakis limit byl" nie wystarcza: podmiana na limit pollera wydluzylaby
      // najgorszy przypadek trzykrotnie, a test dalej bylby zielony.
      expect(zadaneLimity).toEqual([LIMIT_ZAPYTANIA_OFERT_MS]);
    } finally {
      szpieg.mockRestore();
    }
  });

  // Test wyzej bierze wartosc z eksportu, wiec sama JEJ WYSOKOSC jest dla niego niewidoczna.
  it('limit odczytu ofert jest krótszy niż pollera (mnoży się przez 23 strony) i dłuższy niż karty', () => {
    expect(LIMIT_ZAPYTANIA_OFERT_MS).toBeGreaterThan(0);
    expect(LIMIT_ZAPYTANIA_OFERT_MS).toBeLessThan(LIMIT_ZAPYTANIA_ZAMOWIEN_MS);
    // Karta zamowienia to sciezka, przy ktorej czlowiek patrzy w PUSTY EKRAN; tu czeka na
    // wynik przycisku, ktory i tak trwa. Cierpliwosc ma byc wieksza, ale nie pollerowa.
    expect(LIMIT_ZAPYTANIA_OFERT_MS).toBeGreaterThanOrEqual(LIMIT_ZAPYTANIA_PRZESYLEK_MS);
  });

  it('każda strona niesie WŁASNY, świeży sygnał', async () => {
    const fetchImpl = kontoZOfertami(2 * LIMIT_STRONY_OFERT);
    await klient(fetchImpl).pobierzOferty();

    const sygnaly = fetchImpl.mock.calls.map(([, o]) => o.signal);
    expect(sygnaly).toHaveLength(2);
    for (const s of sygnaly) {
      expect(s).toBeInstanceOf(AbortSignal);
      expect(s.aborted).toBe(false);
    }
    expect(sygnaly[0]).not.toBe(sygnaly[1]);
  });
});
