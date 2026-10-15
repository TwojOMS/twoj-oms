import { describe, it, expect } from 'vitest';
import { openOmsDb } from '../../../src/oms/db/db.ts';
import {
  zapiszProduktSklepowy, oznaczZnikniete, liczZyweProdukty, utworzWzor, zapiszWzor,
  powiazProdukt, wzoryZKanalami, niepowiazaneProdukty,
  zliczeniaBrakow, zliczeniaNiepowiazanych, SORTOWANIE_WZOROW,
} from '../../../src/oms/db/magazyn.js';

const P = (nad = {}) => ({
  kanal: 'pro', produkt_id: '944', wariant_id: '1091', nazwa: 'EV 70x100',
  sku_sklepu: 'PRO-EV-118', cena_gr: 7490, kategorie_json: '["Bezpieczeństwo"]',
  zdjecia_json: '["https://pro.szkicownia.pl/x.png","https://pro.szkicownia.pl/x-2.png"]',
  adres: 'https://pro.szkicownia.pl/p/ev',
  rozmiar_tekst: '70 x 100 cm', odczytane_at: '2026-08-06T10:00:00Z', ...nad,
});

describe('zapiszProduktSklepowy — upsert, nie insert', () => {
  it('drugi przebieg odczytu nie mnoży wierszy, tylko aktualizuje', () => {
    const db = openOmsDb(':memory:');
    const a = zapiszProduktSklepowy(db, P());
    const b = zapiszProduktSklepowy(db, P({ cena_gr: 8900, odczytane_at: '2026-08-07T10:00:00Z' }));
    expect(b).toBe(a);
    expect(db.prepare('SELECT COUNT(*) c FROM produkty_sklepowe').get().c).toBe(1);
    expect(db.prepare('SELECT cena_gr FROM produkty_sklepowe').get().cena_gr).toBe(8900);
  });

  // ⚠️ Upsert NIE MA PRAWA ruszyć wzor_id — inaczej każdy odczyt sklepu kasowałby
  // wszystkie powiązania, czyli całą ręczną pracę właściciela.
  it('upsert nie rusza powiązania z wzorem', () => {
    const db = openOmsDb(':memory:');
    const id = zapiszProduktSklepowy(db, P());
    const w = utworzWzor(db, { nazwa: 'EV 70x100' });
    powiazProdukt(db, id, w);
    zapiszProduktSklepowy(db, P({ cena_gr: 9900 }));
    expect(db.prepare('SELECT wzor_id FROM produkty_sklepowe WHERE id=?').get(id).wzor_id).toBe(w);
  });

  it('produkt prosty (bez wariantu) zapisuje się z wariant_id pustym napisem', () => {
    const db = openOmsDb(':memory:');
    zapiszProduktSklepowy(db, P({ wariant_id: undefined }));
    expect(db.prepare('SELECT wariant_id FROM produkty_sklepowe').get().wariant_id).toBe('');
  });

  it('null w wariancie zachowuje się dokładnie tak samo jak brak wariantu', () => {
    const db = openOmsDb(':memory:');
    const a = zapiszProduktSklepowy(db, P({ wariant_id: null }));
    const b = zapiszProduktSklepowy(db, P({ wariant_id: undefined }));
    expect(b).toBe(a);
    expect(db.prepare('SELECT COUNT(*) c FROM produkty_sklepowe').get().c).toBe(1);
  });

  // ⚠️ Identyfikator Allegro przychodzi jako napis, ale Woo oddaje liczbę. Kolumna jest
  // TEXT, więc konwersja musi być JEDNA i po naszej stronie — inaczej ten sam produkt
  // wpadłby dwa razy, raz jako 944, raz jako '944'.
  it('identyfikatory liczbowe lądują w bazie jako napisy', () => {
    const db = openOmsDb(':memory:');
    const a = zapiszProduktSklepowy(db, P({ produkt_id: 944, wariant_id: 1091 }));
    const b = zapiszProduktSklepowy(db, P({ produkt_id: '944', wariant_id: '1091' }));
    expect(b).toBe(a);
    const w = db.prepare('SELECT produkt_id, wariant_id FROM produkty_sklepowe').get();
    expect(w).toEqual({ produkt_id: '944', wariant_id: '1091' });
  });

  it('zapisuje lustro kategorii głównej sklepu, opisu i stanu publikacji', () => {
    const db = openOmsDb(':memory:');
    zapiszProduktSklepowy(db, P({
      kategoria_glowna_zrodla: 'Modern Organic',
      opis_zrodlowy: '<p>Szablon malarski</p>',
      status_publikacji: 'ACTIVE',
    }));
    const w = db.prepare('SELECT kategoria_glowna_zrodla, opis_zrodlowy, status_publikacji'
      + ' FROM produkty_sklepowe').get();
    expect(w).toEqual({
      kategoria_glowna_zrodla: 'Modern Organic',
      opis_zrodlowy: '<p>Szablon malarski</p>',
      status_publikacji: 'ACTIVE',
    });
  });

  it('odmawia zapisu bez kanału i bez identyfikatora produktu', () => {
    const db = openOmsDb(':memory:');
    expect(() => zapiszProduktSklepowy(db, P({ kanal: null }))).toThrow();
    expect(() => zapiszProduktSklepowy(db, P({ produkt_id: undefined }))).toThrow();
  });
});

describe('oznaczZnikniete', () => {
  it('oznacza wiersze niewidziane w tym przebiegu, ale ich nie kasuje', () => {
    const db = openOmsDb(':memory:');
    zapiszProduktSklepowy(db, P({ produkt_id: '1', wariant_id: '' }));
    zapiszProduktSklepowy(db, P({ produkt_id: '2', wariant_id: '', odczytane_at: '2026-08-07T10:00:00Z' }));
    const ile = oznaczZnikniete(db, 'pro', '2026-08-07T10:00:00Z');
    expect(ile).toBe(1);
    expect(db.prepare('SELECT COUNT(*) c FROM produkty_sklepowe').get().c).toBe(2);
    expect(db.prepare("SELECT zniknal_at FROM produkty_sklepowe WHERE produkt_id='1'").get().zniknal_at)
      .toBeTruthy();
  });

  it('produkt zobaczony ponownie przestaje być zniknięty', () => {
    const db = openOmsDb(':memory:');
    zapiszProduktSklepowy(db, P({ produkt_id: '1', wariant_id: '' }));
    oznaczZnikniete(db, 'pro', '2026-08-07T10:00:00Z');
    zapiszProduktSklepowy(db, P({ produkt_id: '1', wariant_id: '', odczytane_at: '2026-08-08T10:00:00Z' }));
    expect(db.prepare("SELECT zniknal_at FROM produkty_sklepowe WHERE produkt_id='1'").get().zniknal_at)
      .toBe(null);
  });

  it('nie dotyka innego kanału', () => {
    const db = openOmsDb(':memory:');
    zapiszProduktSklepowy(db, P({ kanal: 'szkicownia', produkt_id: '9', wariant_id: '' }));
    expect(oznaczZnikniete(db, 'pro', '2026-08-07T10:00:00Z')).toBe(0);
  });

  // ⚠️ Wzór i powiązanie mają PRZEŻYĆ wycofanie produktu ze sprzedaży — kasowanie wiersza
  // zerwałoby ręczną pracę właściciela dokładnie tak samo, jak wzor_id w DO UPDATE SET.
  it('zniknięcie zostawia powiązanie z wzorem nietknięte', () => {
    const db = openOmsDb(':memory:');
    const id = zapiszProduktSklepowy(db, P({ produkt_id: '1', wariant_id: '' }));
    const w = utworzWzor(db, { nazwa: 'W' });
    powiazProdukt(db, id, w);
    oznaczZnikniete(db, 'pro', '2026-08-07T10:00:00Z');
    expect(db.prepare('SELECT wzor_id FROM produkty_sklepowe WHERE id=?').get(id).wzor_id).toBe(w);
  });

  it('drugi przebieg nie przestempluje daty zniknięcia', () => {
    const db = openOmsDb(':memory:');
    zapiszProduktSklepowy(db, P({ produkt_id: '1', wariant_id: '' }));
    oznaczZnikniete(db, 'pro', '2026-08-07T10:00:00Z');
    expect(oznaczZnikniete(db, 'pro', '2026-08-08T10:00:00Z')).toBe(0);
    expect(db.prepare("SELECT zniknal_at FROM produkty_sklepowe WHERE produkt_id='1'").get().zniknal_at)
      .toBe('2026-08-07T10:00:00Z');
  });
});

// Liczba, na ktorej stoi hamulec pustego odczytu (services/magazyn-sync.js): odroznia
// „sklep nic nie ma" od „sklep odmowil kodem 200 i oddal pusta tablice".
describe('liczZyweProdukty', () => {
  it('liczy wyłącznie wiersze TEGO kanału', () => {
    const db = openOmsDb(':memory:');
    zapiszProduktSklepowy(db, P({ kanal: 'pro', produkt_id: '1', wariant_id: '' }));
    zapiszProduktSklepowy(db, P({ kanal: 'pro', produkt_id: '2', wariant_id: '' }));
    zapiszProduktSklepowy(db, P({ kanal: 'szkicownia', produkt_id: '3', wariant_id: '' }));
    expect(liczZyweProdukty(db, 'pro')).toBe(2);
    expect(liczZyweProdukty(db, 'szkicownia')).toBe(1);
  });

  // ⚠️ Produkt wycofany NIE jest juz obecnoscia w kanale. Gdyby sie liczyl, kanal wygaszony
  // przed miesiacem blokowalby wlasny pusty odczyt na zawsze.
  it('nie liczy wierszy zniknietych', () => {
    const db = openOmsDb(':memory:');
    zapiszProduktSklepowy(db, P({ produkt_id: '1', wariant_id: '' }));
    zapiszProduktSklepowy(db, P({ produkt_id: '2', wariant_id: '', odczytane_at: '2026-08-07T10:00:00Z' }));
    oznaczZnikniete(db, 'pro', '2026-08-07T10:00:00Z');
    expect(liczZyweProdukty(db, 'pro')).toBe(1);
  });

  it('kanał, którego nie ma w lustrze, daje zero, a nie błąd', () => {
    expect(liczZyweProdukty(openOmsDb(':memory:'), 'allegro_amarka')).toBe(0);
  });
});

describe('utworzWzor / zapiszWzor', () => {
  it('zakłada wzór i oddaje jego id', () => {
    const db = openOmsDb(':memory:');
    const id = utworzWzor(db, {
      nazwa: 'Pieszy', sku: 'STE-BHP-001', szerokosc_mm: 700, wysokosc_mm: 1000,
      kategoria_glowna: 'Bezpieczeństwo', paczkomat: 'nie', opis: 'Szablon',
    });
    const w = db.prepare('SELECT * FROM wzory WHERE id=?').get(id);
    expect(w.nazwa).toBe('Pieszy');
    expect(w.szerokosc_mm).toBe(700);
    expect(w.paczkomat).toBe('nie');
    expect(w.utworzony_at).toBeTruthy();
    expect(w.zmieniony_at).toBe(w.utworzony_at);
  });

  it('wzór bez nazwy nie powstaje', () => {
    const db = openOmsDb(':memory:');
    expect(() => utworzWzor(db, { sku: 'X-1' })).toThrow();
  });

  it('zapiszWzor zmienia wskazane pola i stempluje datę zmiany', () => {
    const db = openOmsDb(':memory:');
    const id = utworzWzor(db, { nazwa: 'Pieszy' }, { at: '2026-08-06T10:00:00Z' });
    zapiszWzor(db, id, { sku: 'STE-BHP-001', szerokosc_mm: 700 }, { at: '2026-08-07T11:00:00Z' });
    const w = db.prepare('SELECT * FROM wzory WHERE id=?').get(id);
    expect(w.sku).toBe('STE-BHP-001');
    expect(w.szerokosc_mm).toBe(700);
    expect(w.nazwa).toBe('Pieszy');
    expect(w.utworzony_at).toBe('2026-08-06T10:00:00Z');
    expect(w.zmieniony_at).toBe('2026-08-07T11:00:00Z');
  });

  // ⚠️ Nazwa kolumny idzie do SQL-a jako TEKST (parametrem być nie może), więc jedyną
  // ochroną jest biała lista. Cicha akceptacja nieznanego pola byłaby gorsza niż wyjątek:
  // edycja hurtem „ustawiłaby" coś, czego nikt nigdy nie zapisał.
  it('odmawia zapisu pola spoza białej listy', () => {
    const db = openOmsDb(':memory:');
    const id = utworzWzor(db, { nazwa: 'Pieszy' });
    expect(() => zapiszWzor(db, id, { 'nazwa = nazwa, sku': 'x' })).toThrow();
    expect(() => zapiszWzor(db, id, { utworzony_at: '2000-01-01' })).toThrow();
    expect(() => zapiszWzor(db, id, { id: 999 })).toThrow();
  });

  // Trzy stany paczkomatu pilnuje domain/paczkomat.js — baza nie ma prawa przyjąć
  // czwartego, bo filtr „bez oznaczenia paczkomatu" liczy właśnie nieoznaczone.
  it('nieznana wartość paczkomatu ląduje jako nieoznaczone', () => {
    const db = openOmsDb(':memory:');
    const id = utworzWzor(db, { nazwa: 'Pieszy', paczkomat: 'moze' });
    expect(db.prepare('SELECT paczkomat FROM wzory WHERE id=?').get(id).paczkomat).toBe(null);
    zapiszWzor(db, id, { paczkomat: 'tak' });
    expect(db.prepare('SELECT paczkomat FROM wzory WHERE id=?').get(id).paczkomat).toBe('tak');
    zapiszWzor(db, id, { paczkomat: 'byle co' });
    expect(db.prepare('SELECT paczkomat FROM wzory WHERE id=?').get(id).paczkomat).toBe(null);
  });

  it('pusty zestaw zmian nie rusza wiersza', () => {
    const db = openOmsDb(':memory:');
    const id = utworzWzor(db, { nazwa: 'Pieszy' }, { at: '2026-08-06T10:00:00Z' });
    zapiszWzor(db, id, {}, { at: '2026-08-09T10:00:00Z' });
    expect(db.prepare('SELECT zmieniony_at FROM wzory WHERE id=?').get(id).zmieniony_at)
      .toBe('2026-08-06T10:00:00Z');
  });
});

describe('powiazProdukt', () => {
  it('przepina produkt na inny wzór i umie go rozłączyć', () => {
    const db = openOmsDb(':memory:');
    const p = zapiszProduktSklepowy(db, P());
    const a = utworzWzor(db, { nazwa: 'A' });
    const b = utworzWzor(db, { nazwa: 'B' });
    powiazProdukt(db, p, a);
    powiazProdukt(db, p, b);
    expect(db.prepare('SELECT wzor_id FROM produkty_sklepowe WHERE id=?').get(p).wzor_id).toBe(b);
    powiazProdukt(db, p, null);
    expect(db.prepare('SELECT wzor_id FROM produkty_sklepowe WHERE id=?').get(p).wzor_id).toBe(null);
  });

  it('nie da się powiązać z wzorem, którego nie ma', () => {
    const db = openOmsDb(':memory:');
    const p = zapiszProduktSklepowy(db, P());
    expect(() => powiazProdukt(db, p, 424242)).toThrow();
  });
});

describe('wzoryZKanalami — jeden wiersz, ceny z kanałów', () => {
  it('składa ceny kanałów w jeden wiersz', () => {
    const db = openOmsDb(':memory:');
    const w = utworzWzor(db, { nazwa: 'Pieszy 70x100', szerokosc_mm: 700, wysokosc_mm: 1000 });
    powiazProdukt(db, zapiszProduktSklepowy(db, P({ kanal: 'pro', cena_gr: 7490 })), w);
    powiazProdukt(db, zapiszProduktSklepowy(db,
      P({ kanal: 'allegro_szkicownia', produkt_id: '76251', wariant_id: '', cena_gr: 8900 })), w);
    const [wiersz] = wzoryZKanalami(db, {});
    expect(wiersz.kanaly.pro.cena_gr).toBe(7490);
    expect(wiersz.kanaly.allegro_szkicownia.cena_gr).toBe(8900);
    expect(wiersz.kanaly.szkicownia).toBeUndefined();
  });

  it('wzór bez produktów ma pusty zestaw kanałów, a nie brak pola', () => {
    const db = openOmsDb(':memory:');
    utworzWzor(db, { nazwa: 'Sam' });
    const [wiersz] = wzoryZKanalami(db);
    expect(wiersz.kanaly).toEqual({});
    expect(wiersz.nazwa).toBe('Sam');
  });

  // ⚠️ `SELECT w.*, p.*` w jednym złączeniu podmieniłby nazwę WZORU nazwą PRODUKTU —
  // obie kolumny nazywają się `nazwa`, a późniejsza wygrywa po cichu.
  it('nazwa wzoru nie zostaje podmieniona nazwą produktu sklepowego', () => {
    const db = openOmsDb(':memory:');
    const w = utworzWzor(db, { nazwa: 'Pieszy', sku: 'STE-1' });
    powiazProdukt(db, zapiszProduktSklepowy(db, P({ nazwa: 'EV 70x100', sku_sklepu: 'PRO-9' })), w);
    const [wiersz] = wzoryZKanalami(db);
    expect(wiersz.nazwa).toBe('Pieszy');
    expect(wiersz.sku).toBe('STE-1');
    expect(wiersz.kanaly.pro.nazwa).toBe('EV 70x100');
    expect(wiersz.kanaly.pro.sku_sklepu).toBe('PRO-9');
  });

  // ⚠️ To jest test na milimetry jako liczbę. Przy napisie „80x150cm" sortowanie
  // ustawiłoby go PRZED „80x100cm".
  it('sortowanie po wymiarze jest liczbowe', () => {
    const db = openOmsDb(':memory:');
    utworzWzor(db, { nazwa: 'A', szerokosc_mm: 800, wysokosc_mm: 1500 });
    utworzWzor(db, { nazwa: 'B', szerokosc_mm: 800, wysokosc_mm: 1000 });
    const n = wzoryZKanalami(db, { sort: 'wysokosc', kier: 'asc' }).map((x) => x.nazwa);
    expect(n).toEqual(['B', 'A']);
  });

  it('kierunek malejący odwraca kolejność', () => {
    const db = openOmsDb(':memory:');
    utworzWzor(db, { nazwa: 'A', wysokosc_mm: 1500 });
    utworzWzor(db, { nazwa: 'B', wysokosc_mm: 1000 });
    expect(wzoryZKanalami(db, { sort: 'wysokosc', kier: 'desc' }).map((x) => x.nazwa))
      .toEqual(['A', 'B']);
  });

  it('domyślnie sortuje po nazwie, bez względu na kolejność zakładania', () => {
    const db = openOmsDb(':memory:');
    utworzWzor(db, { nazwa: 'Zebra' });
    utworzWzor(db, { nazwa: 'Antylopa' });
    expect(wzoryZKanalami(db).map((x) => x.nazwa)).toEqual(['Antylopa', 'Zebra']);
  });

  // ⚠️ Nazwa kolumny sortowania NIE MOŻE trafić do SQL-a z zapytania HTTP. Biała lista
  // jest tu jedyną ochroną — parametru w `ORDER BY` związać się nie da.
  it('sortowanie spoza białej listy nie trafia do SQL-a i nie wywala listy', () => {
    const db = openOmsDb(':memory:');
    utworzWzor(db, { nazwa: 'A' });
    utworzWzor(db, { nazwa: 'B' });
    const n = wzoryZKanalami(db, { sort: 'nazwa; DROP TABLE wzory', kier: 'asc' }).map((x) => x.nazwa);
    expect(n).toEqual(['A', 'B']);
    expect(db.prepare('SELECT COUNT(*) c FROM wzory').get().c).toBe(2);
    // ...i to samo dla kierunku, który też jest tekstem z adresu.
    expect(wzoryZKanalami(db, { sort: 'nazwa', kier: 'asc; DROP TABLE wzory' }).map((x) => x.nazwa))
      .toEqual(['A', 'B']);
    expect(db.prepare('SELECT COUNT(*) c FROM wzory').get().c).toBe(2);
  });

  // ⚠️ `SORTOWANIE[sort] ?? domyślne` NIE JEST białą listą: `SORTOWANIE` to literał obiektu,
  // więc dziedziczy z `Object.prototype` — `sort` równe nazwie odziedziczonej właściwości
  // NIE JEST `undefined`, `??` go nie łapie, a do `ORDER BY` trafia funkcja natywna.
  // Skutek bez tej ochrony: `SqliteError: syntax error` przy `prepare`, czyli 500 zamiast
  // listy — dokładnie to, przed czym ma chronić reguła „nierozpoznane sortowanie wraca
  // do domyślnego" opisana wyżej.
  it('sortowanie nazwą odziedziczoną z Object.prototype nie wywala listy, tylko sortuje domyślnie', () => {
    const db = openOmsDb(':memory:');
    utworzWzor(db, { nazwa: 'B' });
    utworzWzor(db, { nazwa: 'A' });
    for (const zla of ['constructor', '__proto__', 'toString', 'hasOwnProperty', 'valueOf']) {
      expect(wzoryZKanalami(db, { sort: zla, kier: 'asc' }).map((x) => x.nazwa))
        .toEqual(['A', 'B']);
    }
  });

  // Brak wartości nie jest ani najmniejszy, ani największy — to brak. Tysiąc wzorów bez SKU
  // na czele listy sortowanej po SKU nie odpowiada na żadne pytanie.
  it('puste wartości siedzą na końcu w obu kierunkach', () => {
    const db = openOmsDb(':memory:');
    utworzWzor(db, { nazwa: 'ZeSku', sku: 'STE-1' });
    utworzWzor(db, { nazwa: 'BezSku' });
    expect(wzoryZKanalami(db, { sort: 'sku', kier: 'asc' }).map((x) => x.nazwa))
      .toEqual(['ZeSku', 'BezSku']);
    expect(wzoryZKanalami(db, { sort: 'sku', kier: 'desc' }).map((x) => x.nazwa))
      .toEqual(['ZeSku', 'BezSku']);
  });

  it('fraza szuka po nazwie i po SKU', () => {
    const db = openOmsDb(':memory:');
    utworzWzor(db, { nazwa: 'Pieszy', sku: 'PRO-PIESZY-001' });
    utworzWzor(db, { nazwa: 'Kenitra', sku: 'STE-GEO-014' });
    expect(wzoryZKanalami(db, { fraza: 'piesz' }).map((x) => x.nazwa)).toEqual(['Pieszy']);
    expect(wzoryZKanalami(db, { fraza: 'STE-GEO' }).map((x) => x.nazwa)).toEqual(['Kenitra']);
  });

  // ⚠️ `%` i `_` to znaki wieloznaczne LIKE. Bez ucieczki fraza „%" pokazywałaby CAŁY
  // katalog, a właściciel myślałby, że to wynik wyszukiwania.
  it('znaki wieloznaczne we frazie są zwykłymi znakami', () => {
    const db = openOmsDb(':memory:');
    utworzWzor(db, { nazwa: 'Pieszy' });
    utworzWzor(db, { nazwa: 'Kenitra' });
    utworzWzor(db, { nazwa: 'Rabat 50% off' });
    expect(wzoryZKanalami(db, { fraza: '%' }).map((x) => x.nazwa)).toEqual(['Rabat 50% off']);
    expect(wzoryZKanalami(db, { fraza: '_' })).toEqual([]);
  });

  it('pusta fraza nie zawęża listy', () => {
    const db = openOmsDb(':memory:');
    utworzWzor(db, { nazwa: 'A' });
    expect(wzoryZKanalami(db, { fraza: '   ' }).map((x) => x.nazwa)).toEqual(['A']);
  });

  it('filtr braków znajduje wzory bez SKU i bez wymiarów', () => {
    const db = openOmsDb(':memory:');
    utworzWzor(db, { nazwa: 'Z', sku: 'X-1', szerokosc_mm: 700, wysokosc_mm: 1000 });
    utworzWzor(db, { nazwa: 'BezSku', szerokosc_mm: 700, wysokosc_mm: 1000 });
    utworzWzor(db, { nazwa: 'BezWymiaru', sku: 'X-2' });
    expect(wzoryZKanalami(db, { filtry: { brak: 'sku' } }).map((x) => x.nazwa)).toEqual(['BezSku']);
    expect(wzoryZKanalami(db, { filtry: { brak: 'wymiary' } }).map((x) => x.nazwa)).toEqual(['BezWymiaru']);
  });

  it('filtr braków zna też brak kategorii głównej i brak oznaczenia paczkomatu', () => {
    const db = openOmsDb(':memory:');
    utworzWzor(db, { nazwa: 'Komplet', kategoria_glowna: 'Bezpieczeństwo', paczkomat: 'nie' });
    utworzWzor(db, { nazwa: 'BezKategorii', paczkomat: 'tak' });
    utworzWzor(db, { nazwa: 'BezPaczkomatu', kategoria_glowna: 'Boho' });
    expect(wzoryZKanalami(db, { filtry: { brak: 'kategoria' } }).map((x) => x.nazwa))
      .toEqual(['BezKategorii']);
    expect(wzoryZKanalami(db, { filtry: { brak: 'paczkomat' } }).map((x) => x.nazwa))
      .toEqual(['BezPaczkomatu']);
  });

  it('połowiczne wymiary to nadal brak wymiarów', () => {
    const db = openOmsDb(':memory:');
    utworzWzor(db, { nazwa: 'Polowa', szerokosc_mm: 700 });
    expect(wzoryZKanalami(db, { filtry: { brak: 'wymiary' } }).map((x) => x.nazwa)).toEqual(['Polowa']);
  });

  // ⚠️ Filtr, którego nie rozumiemy, NIE MOŻE poszerzać zbioru. Po filtrze braków idzie
  // zaznaczenie wszystkiego i edycja hurtem — cicho zignorowany filtr znaczyłby
  // hurtową zmianę na całym katalogu.
  it('nieznana wartość braku nie oddaje całej listy', () => {
    const db = openOmsDb(':memory:');
    utworzWzor(db, { nazwa: 'A', sku: 'X-1', szerokosc_mm: 700, wysokosc_mm: 1000 });
    expect(wzoryZKanalami(db, { filtry: { brak: 'cokolwiek' } })).toEqual([]);
  });

  it('filtr kanału zostawia wzory obecne w tym kanale', () => {
    const db = openOmsDb(':memory:');
    const a = utworzWzor(db, { nazwa: 'TylkoPro' });
    const b = utworzWzor(db, { nazwa: 'TylkoSzkicownia' });
    powiazProdukt(db, zapiszProduktSklepowy(db, P({ kanal: 'pro' })), a);
    powiazProdukt(db, zapiszProduktSklepowy(db,
      P({ kanal: 'szkicownia', produkt_id: '5', wariant_id: '' })), b);
    expect(wzoryZKanalami(db, { filtry: { kanal: 'pro' } }).map((x) => x.nazwa)).toEqual(['TylkoPro']);
  });

  // ⚠️ Alias `p` w drugim zapytaniu (`SELECT p.* FROM produkty_sklepowe p ...`) i alias
  // wewnątrz `EXISTS` budowanego przez `warunkiWzorow` żyją w zagnieżdżonych zakresach —
  // dziś to nie jest wstrzyknięcie, ale mina: gdyby ktoś kiedyś przesłonił jeden drugim,
  // filtr kanału zacząłby po cichu ograniczać KTÓRE PRODUKTY wchodzą do `kanaly`, zamiast
  // tylko decydować, KTÓRE WZORY trafiają na listę. Wzór ma dwa różne produkty w dwóch
  // różnych kanałach właśnie po to, żeby przesłonięcie miało szansę się objawić: przy
  // filtrze `kanal: 'pro'` wzór ma wejść na listę (bo ma produkt w PRO), a jego `kanaly`
  // mają pokazać OBA kanały — nie tylko ten, po którym filtrujemy.
  it('filtr kanału na wzorze z dwoma produktami w dwóch kanałach nie ucina drugiego kanału z kanaly', () => {
    const db = openOmsDb(':memory:');
    const w = utworzWzor(db, { nazwa: 'Dwukanalowy' });
    powiazProdukt(db, zapiszProduktSklepowy(db, P({ kanal: 'pro', cena_gr: 7490 })), w);
    powiazProdukt(db, zapiszProduktSklepowy(db,
      P({ kanal: 'szkicownia', produkt_id: '2', wariant_id: '', cena_gr: 5000 })), w);
    const wiersze = wzoryZKanalami(db, { filtry: { kanal: 'pro' } });
    expect(wiersze.map((x) => x.nazwa)).toEqual(['Dwukanalowy']);
    expect(wiersze[0].kanaly.pro.cena_gr).toBe(7490);
    expect(wiersze[0].kanaly.szkicownia.cena_gr).toBe(5000);
  });

  // ⚠️ ROZSTRZYGNIĘCIE: filtr kategorii szuka we WSZYSTKICH kategoriach produktu, nie
  // w wybranej kategorii głównej. Produkt bywa w „Aplikacjach" jako czwartej z siedmiu
  // i filtrowanie po głównej po prostu by go zgubiło.
  it('filtr kategorii łapie kategorię czwartą z siedmiu, nie tylko główną', () => {
    const db = openOmsDb(':memory:');
    const w = utworzWzor(db, { nazwa: 'Hop', kategoria_glowna: 'Modern Organic' });
    powiazProdukt(db, zapiszProduktSklepowy(db, P({
      kategorie_json: '["Boho","Farmhouse","Minimalistyczne","Aplikacje","Na ściany","Modern Organic","Rośliny"]',
    })), w);
    const inny = utworzWzor(db, { nazwa: 'Inny' });
    powiazProdukt(db, zapiszProduktSklepowy(db,
      P({ produkt_id: '2', wariant_id: '', kategorie_json: '["Boho"]' })), inny);
    expect(wzoryZKanalami(db, { filtry: { kategoria: 'Aplikacje' } }).map((x) => x.nazwa))
      .toEqual(['Hop']);
  });

  it('kategoria dopasowuje się w całości, a nie kawałkiem nazwy', () => {
    const db = openOmsDb(':memory:');
    const w = utworzWzor(db, { nazwa: 'Hop' });
    powiazProdukt(db, zapiszProduktSklepowy(db, P({ kategorie_json: '["Na ściany"]' })), w);
    expect(wzoryZKanalami(db, { filtry: { kategoria: 'ścian' } })).toEqual([]);
    expect(wzoryZKanalami(db, { filtry: { kategoria: 'Na ściany' } }).map((x) => x.nazwa)).toEqual(['Hop']);
  });

  // Lustro bierze się z cudzego API — jedna popsuta wartość nie ma prawa położyć CAŁEJ listy.
  it('pusty albo niepoprawny JSON kategorii nie wywala zapytania', () => {
    const db = openOmsDb(':memory:');
    const w = utworzWzor(db, { nazwa: 'Hop' });
    powiazProdukt(db, zapiszProduktSklepowy(db, P({ kategorie_json: null })), w);
    powiazProdukt(db, zapiszProduktSklepowy(db,
      P({ produkt_id: '2', wariant_id: '', kategorie_json: 'to nie jest JSON' })), w);
    const dobry = utworzWzor(db, { nazwa: 'Dobry' });
    powiazProdukt(db, zapiszProduktSklepowy(db,
      P({ produkt_id: '3', wariant_id: '', kategorie_json: '["Boho"]' })), dobry);
    expect(wzoryZKanalami(db, { filtry: { kategoria: 'Boho' } }).map((x) => x.nazwa)).toEqual(['Dobry']);
  });

  // ⚠️ ROZSTRZYGNIĘCIE (Zadanie 4, wątpliwość 1): filtr kategorii ma być NADZBIOREM —
  // dopasowanie po kategoriach produktów w lustrze ALBO po `wzory.kategoria_glowna`.
  // Wzór, któremu właściciel ręcznie ustawił kategorię główną hurtem, ale który (jeszcze)
  // nie ma powiązanego produktu w lustrze — albo którego jedyny produkt zniknął ze sklepu,
  // albo który istnieje tylko na Allegro poza lustrem — ma się nadal znaleźć. Fałszywie
  // pominięty wiersz jest tu gorszy niż wiersz nadmiarowy: to właśnie ten filtr jest drogą,
  // którą ustawia się kategorię główną hurtem, a wzoru niewidocznego w filtrze nią nie
  // oznaczysz.
  it('wzór z ustawioną kategorią główną, ale bez powiązanego produktu, znajduje się przy filtrze po tej kategorii', () => {
    const db = openOmsDb(':memory:');
    utworzWzor(db, { nazwa: 'BezProduktu', kategoria_glowna: 'Aplikacje' });
    expect(wzoryZKanalami(db, { filtry: { kategoria: 'Aplikacje' } }).map((x) => x.nazwa))
      .toEqual(['BezProduktu']);
  });

  it('wzór, którego ani kategoria główna, ani kategorie produktu nie zawierają frazy, nie wchodzi do wyniku', () => {
    const db = openOmsDb(':memory:');
    const w = utworzWzor(db, { nazwa: 'Boho', kategoria_glowna: 'Boho' });
    powiazProdukt(db, zapiszProduktSklepowy(db, P({ kategorie_json: '["Farmhouse"]' })), w);
    expect(wzoryZKanalami(db, { filtry: { kategoria: 'Aplikacje' } })).toEqual([]);
  });

  // ⚠️ Nadzbiór (kategoria_glowna OR kategorie produktów) nie ma prawa dublować wiersza:
  // wzór powiązany z dwoma produktami, z których OBA mają tę kategorię, ma wyjść RAZ.
  it('wzór z kilkoma produktami mającymi tę samą kategorię wychodzi raz, nie dwa razy', () => {
    const db = openOmsDb(':memory:');
    const w = utworzWzor(db, { nazwa: 'Podwojny' });
    powiazProdukt(db, zapiszProduktSklepowy(db,
      P({ kanal: 'pro', kategorie_json: '["Aplikacje"]' })), w);
    powiazProdukt(db, zapiszProduktSklepowy(db,
      P({ kanal: 'szkicownia', produkt_id: '2', wariant_id: '', kategorie_json: '["Aplikacje"]' })), w);
    expect(wzoryZKanalami(db, { filtry: { kategoria: 'Aplikacje' } }).map((x) => x.nazwa))
      .toEqual(['Podwojny']);
  });

  it('filtr paczkomatu ma trzy stany, a nieoznaczone to nie to samo co „nie"', () => {
    const db = openOmsDb(':memory:');
    utworzWzor(db, { nazwa: 'Tak', paczkomat: 'tak' });
    utworzWzor(db, { nazwa: 'Nie', paczkomat: 'nie' });
    utworzWzor(db, { nazwa: 'Nieoznaczony' });
    expect(wzoryZKanalami(db, { filtry: { paczkomat: 'tak' } }).map((x) => x.nazwa)).toEqual(['Tak']);
    expect(wzoryZKanalami(db, { filtry: { paczkomat: 'nie' } }).map((x) => x.nazwa)).toEqual(['Nie']);
    expect(wzoryZKanalami(db, { filtry: { paczkomat: 'nieoznaczone' } }).map((x) => x.nazwa))
      .toEqual(['Nieoznaczony']);
  });

  it('filtr ceny bierze zakres w groszach', () => {
    const db = openOmsDb(':memory:');
    const a = utworzWzor(db, { nazwa: 'Tania' });
    const b = utworzWzor(db, { nazwa: 'Droga' });
    powiazProdukt(db, zapiszProduktSklepowy(db, P({ cena_gr: 2000 })), a);
    powiazProdukt(db, zapiszProduktSklepowy(db, P({ produkt_id: '2', wariant_id: '', cena_gr: 20000 })), b);
    expect(wzoryZKanalami(db, { filtry: { cenaOd: 10000 } }).map((x) => x.nazwa)).toEqual(['Droga']);
    expect(wzoryZKanalami(db, { filtry: { cenaDo: 10000 } }).map((x) => x.nazwa)).toEqual(['Tania']);
  });

  // ⚠️ PRODUKT BEZ CENY (`cena_gr IS NULL`) WYPADA Z KAŻDEGO ZAKRESU — także z samego
  // „do 200 zł", gdzie instynkt podpowiada, że „nie wiem" mieści się poniżej progu.
  // To jest zachowanie ZAMIERZONE i warte przypięcia z dwóch powodów. Po pierwsze, w SQLite
  // każde porównanie z NULL-em daje NULL, czyli wiersz odpada — więc to, co dziś jest
  // regułą, jutro byłoby przypadkiem przy pierwszym przepisaniu warunku na `IFNULL`.
  // Po drugie, ekran renderuje ten sam stan jako TRZECI, ZNACZĄCY („bez ceny" zamiast
  // kreski): rodzic produktu wariantowego i produkt w przygotowaniu naprawdę nie mają ceny,
  // a `0` znaczyłoby „za darmo" i wpadało w każdy zakres od zera w górę.
  it('produkt bez ceny nie wpada do żadnego zakresu — ani od, ani do', () => {
    const db = openOmsDb(':memory:');
    const zCena = utworzWzor(db, { nazwa: 'Z ceną' });
    const bezCeny = utworzWzor(db, { nazwa: 'Bez ceny' });
    powiazProdukt(db, zapiszProduktSklepowy(db, P({ cena_gr: 5000 })), zCena);
    powiazProdukt(db, zapiszProduktSklepowy(db,
      P({ produkt_id: '2', wariant_id: '', cena_gr: null })), bezCeny);

    expect(wzoryZKanalami(db, { filtry: { cenaDo: 20000 } }).map((x) => x.nazwa)).toEqual(['Z ceną']);
    expect(wzoryZKanalami(db, { filtry: { cenaOd: 1 } }).map((x) => x.nazwa)).toEqual(['Z ceną']);
    // ...ale bez filtru ceny wzór jest widoczny normalnie: brak ceny nie wyklucza go
    // z magazynu, tylko z ZAWĘŻENIA po cenie.
    expect(wzoryZKanalami(db, {}).map((x) => x.nazwa).sort()).toEqual(['Bez ceny', 'Z ceną']);
  });

  // Zakres ceny i kanał opisują TEN SAM produkt — inaczej „PRO od 100 zł" pokazywałoby wzór,
  // który na PRO kosztuje 20 zł, a setkę przekracza dopiero na Allegro.
  it('zakres ceny liczy się w wybranym kanale, nie w dowolnym', () => {
    const db = openOmsDb(':memory:');
    const w = utworzWzor(db, { nazwa: 'Mieszana' });
    powiazProdukt(db, zapiszProduktSklepowy(db, P({ kanal: 'pro', cena_gr: 2000 })), w);
    powiazProdukt(db, zapiszProduktSklepowy(db,
      P({ kanal: 'allegro_szkicownia', produkt_id: '2', wariant_id: '', cena_gr: 20000 })), w);
    expect(wzoryZKanalami(db, { filtry: { kanal: 'pro', cenaOd: 10000 } })).toEqual([]);
    expect(wzoryZKanalami(db, { filtry: { kanal: 'allegro_szkicownia', cenaOd: 10000 } })
      .map((x) => x.nazwa)).toEqual(['Mieszana']);
  });

  it('filtry łączą się z frazą, a nie kasują jej', () => {
    const db = openOmsDb(':memory:');
    const a = utworzWzor(db, { nazwa: 'Pieszy' });
    const b = utworzWzor(db, { nazwa: 'Pieszy inny' });
    utworzWzor(db, { nazwa: 'Kenitra' });
    powiazProdukt(db, zapiszProduktSklepowy(db, P({ kanal: 'pro' })), a);
    powiazProdukt(db, zapiszProduktSklepowy(db,
      P({ kanal: 'szkicownia', produkt_id: '2', wariant_id: '' })), b);
    expect(wzoryZKanalami(db, { fraza: 'pieszy', filtry: { kanal: 'pro' } }).map((x) => x.nazwa))
      .toEqual(['Pieszy']);
  });

  // ⚠️ Cena zniknietego produktu twierdziłaby, że wzór jest w tym kanale do kupienia.
  // Wiersz zostaje w bazie (powiązanie ma przeżyć), ale z listy dostępności wypada.
  it('produkt zniknięty ze sklepu nie udaje ceny w kanale', () => {
    const db = openOmsDb(':memory:');
    const w = utworzWzor(db, { nazwa: 'Wycofany' });
    powiazProdukt(db, zapiszProduktSklepowy(db, P({ kanal: 'pro' })), w);
    oznaczZnikniete(db, 'pro', '2026-08-07T10:00:00Z');
    const [wiersz] = wzoryZKanalami(db);
    expect(wiersz.kanaly.pro).toBeUndefined();
    expect(wzoryZKanalami(db, { filtry: { kanal: 'pro' } })).toEqual([]);
  });

  it('dwa warianty tego samego kanału dają zawsze ten sam, deterministyczny wybór', () => {
    const db = openOmsDb(':memory:');
    const w = utworzWzor(db, { nazwa: 'Dwa warianty' });
    const pierwszy = zapiszProduktSklepowy(db, P({ wariant_id: '1', cena_gr: 1000 }));
    const drugi = zapiszProduktSklepowy(db, P({ wariant_id: '2', cena_gr: 2000 }));
    powiazProdukt(db, drugi, w);
    powiazProdukt(db, pierwszy, w);
    expect(wzoryZKanalami(db)[0].kanaly.pro.id).toBe(pierwszy);
  });
});

describe('niepowiazaneProdukty', () => {
  it('oddaje wyłącznie produkty bez wzoru i bez zniknal_at', () => {
    const db = openOmsDb(':memory:');
    const wolny = zapiszProduktSklepowy(db, P({ produkt_id: '1', wariant_id: '' }));
    const zajety = zapiszProduktSklepowy(db, P({ produkt_id: '2', wariant_id: '' }));
    powiazProdukt(db, zajety, utworzWzor(db, { nazwa: 'W' }));
    zapiszProduktSklepowy(db, P({ produkt_id: '3', wariant_id: '' }));
    oznaczZnikniete(db, 'pro', '2026-08-09T10:00:00Z');
    zapiszProduktSklepowy(db, P({ produkt_id: '1', wariant_id: '', odczytane_at: '2026-08-09T10:00:00Z' }));
    expect(niepowiazaneProdukty(db).map((p) => p.id)).toEqual([wolny]);
  });

  it('oddaje pełny wiersz produktu, nie samo id', () => {
    const db = openOmsDb(':memory:');
    zapiszProduktSklepowy(db, P());
    const [p] = niepowiazaneProdukty(db);
    expect(p.kanal).toBe('pro');
    expect(p.nazwa).toBe('EV 70x100');
    expect(p.kategorie_json).toBe('["Bezpieczeństwo"]');
    expect(p.rozmiar_tekst).toBe('70 x 100 cm');
  });
});

// ⚠️ TO NIE JEST TEST OZDOBNY. Zapytanie „per wzór" przy tysiącu wzorów znaczy tysiąc
// zapytań na KAŻDE otwarcie listy — usterka, która na pustej bazie testowej jest
// niewidoczna, a na produkcyjnej kładzie ekran.
//
// ⚠️⚠️ SAM BUDŻET CZASU TEGO NIE ŁAPIE i to jest zmierzone, nie przypuszczane: wersja
// „per wzór" schodzi na bazie w pamięci w ~55 ms, czyli mieści się w progu 200 ms
// z zapasem. Dlatego niezmiennik jest sprawdzany WPROST — liczbą zapytań, która ma NIE
// ROSNĄĆ z liczbą wzorów. Czas zostaje jako druga siatka, na wypadek zapytania, które
// jest jedno, ale kosztuje tyle co tysiąc.
function bazaZLicznikiem(db) {
  const licznik = { zapytania: 0 };
  const opakuj = (st) => ({
    all: (...a) => { licznik.zapytania += 1; return st.all(...a); },
    get: (...a) => { licznik.zapytania += 1; return st.get(...a); },
    run: (...a) => { licznik.zapytania += 1; return st.run(...a); },
  });
  return [{ prepare: (sql) => opakuj(db.prepare(sql)) }, licznik];
}

describe('wzoryZKanalami — koszt renderu listy', () => {
  it('liczba zapytań nie rośnie z liczbą wzorów', () => {
    const db = openOmsDb(':memory:');
    const zbuduj = (ile) => {
      for (let i = 0; i < ile; i += 1) {
        const w = utworzWzor(db, { nazwa: `Wzor ${i}` });
        powiazProdukt(db, zapiszProduktSklepowy(db, P({
          produkt_id: `${db.prepare('SELECT COUNT(*) c FROM produkty_sklepowe').get().c}`,
          wariant_id: '',
        })), w);
      }
    };

    zbuduj(3);
    const [maly, licznikMaly] = bazaZLicznikiem(db);
    expect(wzoryZKanalami(maly)).toHaveLength(3);

    zbuduj(200);
    const [duzy, licznikDuzy] = bazaZLicznikiem(db);
    expect(wzoryZKanalami(duzy)).toHaveLength(203);

    expect(licznikDuzy.zapytania).toBe(licznikMaly.zapytania);
    expect(licznikDuzy.zapytania).toBeLessThanOrEqual(2);
  });

  it('tysiąc wzorów z produktem schodzi poniżej 200 ms', () => {
    const db = openOmsDb(':memory:');
    db.exec('BEGIN');
    for (let i = 0; i < 1000; i += 1) {
      const w = utworzWzor(db, {
        nazwa: `Wzor ${String(i).padStart(4, '0')}`,
        sku: `STE-${i}`,
        szerokosc_mm: 700,
        wysokosc_mm: 1000 + i,
        kategoria_glowna: 'Bezpieczeństwo',
      });
      powiazProdukt(db, zapiszProduktSklepowy(db, P({
        produkt_id: String(i), wariant_id: '', cena_gr: 1000 + i,
      })), w);
    }
    db.exec('COMMIT');

    const start = performance.now();
    const wiersze = wzoryZKanalami(db, { sort: 'wysokosc', kier: 'desc' });
    const czas = performance.now() - start;

    expect(wiersze).toHaveLength(1000);
    expect(wiersze[0].kanaly.pro.cena_gr).toBe(1999);
    expect(czas).toBeLessThan(200);
  });
});

// ⚠️⚠️ BRAKI WZORU MAJĄ JEDNĄ DEFINICJĘ, A UŻYĆ ICH TRZEBA W CZTERECH MIEJSCACH NARAZ:
// filtr `brak=…`, kolumna `liczba_brakow` w wierszu listy, sortowanie „najwięcej braków na
// czele" i zliczenia kafli nad tabelą. Kafel PROWADZI do listy, więc druga kopia
// któregokolwiek wyrażenia znaczyłaby „kafel mówi 217, lista pokazuje 214" — i nie byłoby
// jak zgadnąć, która liczba kłamie. Dlatego wszystkie cztery zastosowania są tu pytane
// o TĘ SAMĄ fiksturę, a nie każde o swoją.
describe('braki wzoru — jedna definicja dla filtra, listy i zliczeń', () => {
  // ⚠️ FIKSTURA Z WŁASNYM STRAŻNIKIEM. „Kompletny ma 0 braków" jest zdaniem o wzorze, który
  // NAPRAWDĘ ma komplet — a `utworzWzor` przepuszcza `paczkomat` przez `czyPaczkomat`, więc
  // literówka w wartości zostawiłaby po cichu NULL i test mierzyłby co innego, niż mówi jego
  // nazwa. Odczyt wiersza po utworzeniu zamyka tę drogę z obu stron: kompletny ma wszystkie
  // pięć kolumn wypełnionych, dziurawy ani jednej.
  function paraWzorow(db) {
    const kompletny = utworzWzor(db, {
      nazwa: 'Kompletny', sku: 'STE-X-001', szerokosc_mm: 700, wysokosc_mm: 1000,
      kategoria_glowna: 'Na ściany', paczkomat: 'nie',
    });
    const dziurawy = utworzWzor(db, { nazwa: 'Dziurawy' });

    const stan = (id) => db.prepare(
      'SELECT sku, szerokosc_mm, wysokosc_mm, kategoria_glowna, paczkomat FROM wzory WHERE id = ?',
    ).get(id);
    expect(stan(kompletny), 'kompletny ma NAPRAWDĘ komplet pól').toEqual({
      sku: 'STE-X-001',
      szerokosc_mm: 700,
      wysokosc_mm: 1000,
      kategoria_glowna: 'Na ściany',
      paczkomat: 'nie',
    });
    expect(stan(dziurawy), 'dziurawy NAPRAWDĘ nie ma żadnego z czterech').toEqual({
      sku: null, szerokosc_mm: null, wysokosc_mm: null, kategoria_glowna: null, paczkomat: null,
    });
    return { kompletny, dziurawy };
  }

  it('liczba_brakow: 0 dla kompletnego, 4 dla pustego', () => {
    const db = openOmsDb(':memory:');
    paraWzorow(db);
    const wiersze = wzoryZKanalami(db, {});
    const poNazwie = Object.fromEntries(wiersze.map((w) => [w.nazwa, w.liczba_brakow]));
    expect(poNazwie.Kompletny).toBe(0);
    expect(poNazwie.Dziurawy).toBe(4);
  });

  // Ta sama reguła co w filtrze „bez wymiarów" (4.23): do cięcia potrzebne są OBA wymiary,
  // więc sama szerokość nie jest połową braku, tylko brakiem.
  it('połowiczny wymiar to nadal brak wymiaru', () => {
    const db = openOmsDb(':memory:');
    utworzWzor(db, {
      nazwa: 'Połowa', sku: 'S', szerokosc_mm: 700, kategoria_glowna: 'X', paczkomat: 'tak',
    });
    expect(wzoryZKanalami(db, {})[0].liczba_brakow).toBe(1);
  });

  // ⚠️ SKU Z SAMYCH SPACJI TO NADAL BRAK, NIE NUMER — ten sam warunek, co w `nadajSku`
  // i w `bezSku` (`domain/przejecie-sku.js`). Bez TRIM ten wzór liczyłby się tutaj jako
  // komplet, a `nadajSku` i tak przydzieliłby mu numer — dwie sprzeczne odpowiedzi na to
  // samo pytanie o tym samym wzorze.
  it('SKU z samych spacji to nadal brak, nie komplet', () => {
    const db = openOmsDb(':memory:');
    utworzWzor(db, {
      nazwa: 'SamaSpacja', sku: '   ', szerokosc_mm: 700, wysokosc_mm: 1000,
      kategoria_glowna: 'X', paczkomat: 'tak',
    });

    expect(wzoryZKanalami(db, {})[0].liczba_brakow).toBe(1);
    expect(wzoryZKanalami(db, { filtry: { brak: 'sku' } }).map((w) => w.nazwa))
      .toEqual(['SamaSpacja']);
    expect(wzoryZKanalami(db, { filtry: { brak: 'komplet' } })).toEqual([]);
    expect(zliczeniaBrakow(db)).toMatchObject({ bezSku: 1, komplet: 0 });
  });

  it('filtr brak=komplet oddaje wyłącznie kompletne', () => {
    const db = openOmsDb(':memory:');
    paraWzorow(db);
    const wiersze = wzoryZKanalami(db, { filtry: { brak: 'komplet' } });
    expect(wiersze.map((w) => w.nazwa)).toEqual(['Kompletny']);
  });

  it('sort=braki desc ustawia największe braki na czele (kolejka roboty)', () => {
    const db = openOmsDb(':memory:');
    paraWzorow(db);
    expect(wzoryZKanalami(db, { sort: 'braki', kier: 'desc' }).map((w) => w.nazwa))
      .toEqual(['Dziurawy', 'Kompletny']);
    expect(wzoryZKanalami(db, { sort: 'braki', kier: 'asc' }).map((w) => w.nazwa))
      .toEqual(['Kompletny', 'Dziurawy']);
    // ⚠️ Nagłówek tabeli buduje odnośniki sortujące z TEJ listy. Klucz nieznany zapytaniu
    // wracałby po cichu do sortowania domyślnego, a kolumna dalej świeciłaby jako aktywna.
    expect(SORTOWANIE_WZOROW).toContain('braki');
  });

  // ⚠️⚠️ KAŻDY LICZNIK MA W TEJ FIKSTURZE INNĄ WARTOŚĆ — i to nie jest ozdoba, tylko
  // naprawa fałszywej zieleni ZŁAPANEJ MUTACJĄ. Wcześniej stały tu dwa wzory i wszystkie
  // liczniki wychodziły po jednym; przestawienie aliasów `bezSku` ↔ `bezWymiarow`
  // w zapytaniu PRZESZŁO NA ZIELONO, czyli kafle mogłyby pokazywać swoje liczby nawzajem,
  // a każdy prowadzić do cudzej listy. Przy różnych wartościach każda taka zamiana pada.
  const ILE = Object.freeze({ sku: 4, wymiary: 3, kategoria: 5, paczkomat: 6 });
  const DO_PRZEJECIA = 2;

  function katalogZliczen(db) {
    // `wzory.sku` ma UNIQUE, więc każdy pełny wzór dostaje własny numer.
    const pelny = (nazwa) => ({
      nazwa, sku: `STE-${nazwa}`, szerokosc_mm: 700, wysokosc_mm: 1000,
      kategoria_glowna: 'Boho', paczkomat: 'nie',
    });
    const dziura = {
      sku: { sku: null },
      wymiary: { wysokosc_mm: null },
      kategoria: { kategoria_glowna: null },
      paczkomat: { paczkomat: null },
    };

    utworzWzor(db, pelny('Komplet'));
    const bezSku = [];
    for (const [czego, ile] of Object.entries(ILE)) {
      for (let i = 0; i < ile; i += 1) {
        const id = utworzWzor(db, { ...pelny(`${czego}-${i}`), ...dziura[czego] });
        if (czego === 'sku') bezSku.push(id);
      }
    }

    // Numeru nie wymyślamy — bierzemy go ze sklepu (domain/przejecie-sku.js). Dostają go
    // DWA z czterech wzorów bez SKU, żeby „do przejęcia" nie mogło być kopią „bez SKU".
    bezSku.slice(0, DO_PRZEJECIA).forEach((wzorId, i) => {
      powiazProdukt(db, zapiszProduktSklepowy(db, {
        kanal: 'szkicownia', produkt_id: `90${i}`, nazwa: `Zrodlo ${i}`, sku_sklepu: `PD1${i}`,
        cena_gr: 2900, odczytane_at: '2026-08-20T10:00:00Z',
      }), wzorId);
    });

    // ⚠️ STRAŻNIK FIKSTURY, liczony WŁASNYM SQL-em — nie tym, o który pyta test. Gdyby
    // katalog nie zawierał tego, co test o nim mówi, wszystkie liczby niżej opisywałyby
    // co innego, niż głoszą ich nazwy.
    const licz = (warunek) => db.prepare(`SELECT COUNT(*) AS c FROM wzory WHERE ${warunek}`).get().c;
    expect({
      razem: licz('1 = 1'),
      bezSku: licz("sku IS NULL OR sku = ''"),
      bezWymiarow: licz('szerokosc_mm IS NULL OR wysokosc_mm IS NULL'),
      bezKategorii: licz("kategoria_glowna IS NULL OR kategoria_glowna = ''"),
      bezPaczkomatu: licz('paczkomat IS NULL'),
      zZrodlemNumeru: db.prepare(
        "SELECT COUNT(*) AS c FROM produkty_sklepowe WHERE sku_sklepu != '' AND wzor_id IS NOT NULL",
      ).get().c,
    }, 'katalog NAPRAWDĘ zawiera to, co test o nim mówi').toEqual({
      razem: 19, bezSku: 4, bezWymiarow: 3, bezKategorii: 5, bezPaczkomatu: 6, zZrodlemNumeru: 2,
    });
  }

  // ⚠️ ZLICZENIA LICZĄ PO CAŁYM KATALOGU, nie po przefiltrowanej liście — kafel ma mówić,
  // ile roboty zostało w ogóle, a nie ile jej widać przy akurat ustawionym filtrze.
  // ⚠️ I NIGDY NIE ODDAJĄ NULL: `SUM` na pustej tabeli to NULL, a „brak: null" w widoku
  // wypisałoby się jako puste miejsce w kaflu, czyli jak awaria odczytu.
  it('zliczeniaBrakow na pustym katalogu oddaje ZERA, a nie null-e', () => {
    const db = openOmsDb(':memory:');
    expect(zliczeniaBrakow(db)).toEqual({
      razem: 0, bezSku: 0, doPrzejecia: 0, bezWymiarow: 0, bezKategorii: 0, bezPaczkomatu: 0, komplet: 0,
    });
  });

  it('zliczeniaBrakow liczy po CAŁYM katalogu — każdy kafel swoją liczbę', () => {
    const db = openOmsDb(':memory:');
    katalogZliczen(db);
    expect(zliczeniaBrakow(db)).toEqual({
      razem: 19,
      bezSku: 4,
      doPrzejecia: 2,
      bezWymiarow: 3,
      bezKategorii: 5,
      bezPaczkomatu: 6,
      komplet: 1,
    });
  });

  // ⚠️ Wzór bez SKU, któremu sklep nie ma czego oddać, do PRZEJĘCIA się nie nadaje. Trzy
  // powody z osobna, bo każdy jest osobnym członem warunku: produkt bez numeru w sklepie,
  // produkt WYCOFANY ze sklepu (numer wycofanego produktu nie jest już źródłem) i produkt
  // niepowiązany z żadnym wzorem. Bez nich kafel „do przejęcia" byłby kopią „bez SKU".
  it('do przejęcia liczy wyłącznie te, którym ŻYWY produkt ma co oddać', () => {
    const db = openOmsDb(':memory:');
    const produkt = (nad) => zapiszProduktSklepowy(db, {
      kanal: 'szkicownia', cena_gr: 1000, odczytane_at: '2026-08-21T10:00:00Z', ...nad,
    });

    // (1) produkt żywy i powiązany, ale sklep numeru nie ma — nie ma czego przejąć.
    powiazProdukt(db, produkt({ produkt_id: '1', nazwa: 'Bez numeru', sku_sklepu: '' }),
      utworzWzor(db, { nazwa: 'BezZrodla' }));
    // (2) numer jest i wisi na właściwym wzorze, ale produkt WYPADŁ ze sklepu.
    powiazProdukt(db, produkt({
      produkt_id: '2', nazwa: 'Wycofany', sku_sklepu: 'PD20', odczytane_at: '2026-08-20T10:00:00Z',
    }), utworzWzor(db, { nazwa: 'ZeZrodlemWycofanym' }));
    // (3) numer jest i produkt żyje, ale nikt go z tym wzorem nie powiązał.
    produkt({ produkt_id: '3', nazwa: 'Niczyj', sku_sklepu: 'PD30' });
    utworzWzor(db, { nazwa: 'BezProduktu' });

    expect(oznaczZnikniete(db, 'szkicownia', '2026-08-21T10:00:00Z'), 'DOKŁADNIE jeden wypadł ze sklepu')
      .toBe(1);

    expect(zliczeniaBrakow(db)).toMatchObject({ razem: 3, bezSku: 3, doPrzejecia: 0 });
  });

  it('zliczeniaNiepowiazanych: żywe bez wzoru, w tym oferty Allegro', () => {
    const db = openOmsDb(':memory:');
    const przy = (nad) => ({ cena_gr: 100, odczytane_at: '2026-08-20T10:00:00Z', ...nad });
    zapiszProduktSklepowy(db, przy({ kanal: 'szkicownia', produkt_id: '1', nazwa: 'A' }));
    zapiszProduktSklepowy(db, przy({ kanal: 'allegro_szkicownia', produkt_id: '2', nazwa: 'B' }));
    zapiszProduktSklepowy(db, przy({ kanal: 'allegro_amarka', produkt_id: '3', nazwa: 'C' }));
    expect(zliczeniaNiepowiazanych(db, ['allegro_szkicownia', 'allegro_amarka'])).toEqual({ pominiete: 3, ofertyAllegro: 2 });
  });

  // ⚠️ Produkt POWIĄZANY nie jest pominięty, a produkt ZNIKNIĘTY ze sklepu nie jest robotą
  // do wykonania — kafel prowadzący do ekranu tworzenia wzorów nie ma prawa obiecywać pracy
  // przy wierszach, których ten ekran w ogóle nie pokaże (`niepowiazaneProdukty`).
  it('zliczeniaNiepowiazanych pomija powiązane i zniknięte', () => {
    const db = openOmsDb(':memory:');
    const powiazany = zapiszProduktSklepowy(db, {
      kanal: 'szkicownia', produkt_id: '1', nazwa: 'A', cena_gr: 100, odczytane_at: '2026-08-20T10:00:00Z',
    });
    powiazProdukt(db, powiazany, utworzWzor(db, { nazwa: 'W' }));
    zapiszProduktSklepowy(db, {
      kanal: 'allegro_szkicownia', produkt_id: '2', nazwa: 'B', cena_gr: 100, odczytane_at: '2026-08-20T10:00:00Z',
    });
    zapiszProduktSklepowy(db, {
      kanal: 'allegro_szkicownia', produkt_id: '3', nazwa: 'C', cena_gr: 100, odczytane_at: '2026-08-19T10:00:00Z',
    });
    expect(oznaczZnikniete(db, 'allegro_szkicownia', '2026-08-20T10:00:00Z'), 'jeden NAPRAWDĘ zniknął')
      .toBe(1);

    expect(zliczeniaNiepowiazanych(db, ['allegro_szkicownia', 'allegro_amarka'])).toEqual({ pominiete: 1, ofertyAllegro: 1 });
  });
});
