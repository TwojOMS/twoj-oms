import { describe, it, expect, beforeEach } from 'vitest';
import {
  filtryZZapytania,
  parametryUkryte,
  wartosciPol,
  saJakiesFiltry,
  adresMagazynu,
  BRAKI_MAGAZYNU,
  BRAKI_ETYKIETY,
  kluczBrakuParametru,
} from '../../../src/domena/magazyn-filtry.js';
import { dodajParametr, ustawWartoscKarty, listaParametrow } from '../../../src/oms/db/parametry-kart.js';
// Jawne wejście historycznych testów; pętle sprawdzają filtr i zachowanie bazy.
const KANALY_MAGAZYNU = ['pro', 'swietlik', 'allegro_swietlik', 'allegro_polcien2'];
import { openOmsDb } from '../../../src/oms/db/db.ts';
import {
  utworzKarte,
  zapiszProduktSklepowy,
  powiazProdukt,
  kartyZKanalami,
  zliczeniaBrakow,
} from '../../../src/oms/db/magazyn.js';
import { zapiszCeneZakupu } from '../../../src/oms/db/ceny-zakupu.js';
import { dzienWarszawa } from '../../../src/domena/format-daty.js';

// FILTRY MAGAZYNU — warstwa czysta miedzy adresem HTTP a zapytaniem.
//
// ⚠️ Ten modul jest SLOWNIKIEM, ktory musi sie zgadzac z `db/magazyn.js` co do jednej
// wartosci. Warstwa zapytan traktuje NIEZNANA wartosc filtru jako `1 = 0`, czyli oddaje
// PUSTO — swiadomie, bo filtr, ktorego nie rozumiemy, nie ma prawa poszerzac zbioru przed
// edycja hurtem. Skutek uboczny jest taki, ze pozycja wystawiona w interfejsie, a nieznana
// bazie, daje PUSTY EKRAN zamiast wyniku — i wyglada jak „nie ma takich kart", a nie jak
// brakujaca funkcja. Dlatego kazda z trzech list nizej jest przypieta do zachowania bazy,
// a nie tylko do samej siebie.

describe('filtryZZapytania — czytanie adresu', () => {
  it('czyta wszystkie filtry naraz', () => {
    expect(
      filtryZZapytania(
        {
          fraza: 'szpulka',
          kanal: 'pro',
          kategoria: 'Aplikacje',
          marka: 'Półcień',
          brak: 'sku',
          parametr: '3',
          pbez: '1',
          cenaOd: '10',
          cenaDo: '99',
        },
        ['pro', 'swietlik', 'allegro_swietlik', 'allegro_polcien2'],
      ),
    ).toEqual({
      fraza: 'szpulka',
      kanal: 'pro',
      kategoria: 'Aplikacje',
      marka: 'Półcień',
      brak: 'sku',
      parametr: 3,
      pw: null,
      pod: null,
      pdo: null,
      pbez: '1',
      // Ceny w GROSZACH — kolumna `produkty_sklepowe.cena_gr` jest INTEGER-em w groszach,
      // a porownanie zlotowek z groszami przesunie granice filtru o dwa rzedy wielkosci.
      cenaOd: 1000,
      cenaDo: 9900,
    });
  });

  it('puste pole ceny to brak filtru, a nie zero', () => {
    // Zero jest WARTOSCIA: „od 0 zl" przepuszcza produkty za darmo i rodzicow wariantowych.
    // Puste pole formularza ma znaczyc „nie zawezaj", i te dwie rzeczy nie moga byc tym samym.
    expect(filtryZZapytania({ cenaOd: '' }, ['pro', 'swietlik', 'allegro_swietlik', 'allegro_polcien2']).cenaOd).toBe(
      null,
    );
    expect(
      filtryZZapytania({ cenaOd: '   ' }, ['pro', 'swietlik', 'allegro_swietlik', 'allegro_polcien2']).cenaOd,
    ).toBe(null);
    expect(filtryZZapytania({}, ['pro', 'swietlik', 'allegro_swietlik', 'allegro_polcien2']).cenaOd).toBe(null);
    expect(filtryZZapytania({ cenaOd: '0' }, ['pro', 'swietlik', 'allegro_swietlik', 'allegro_polcien2']).cenaOd).toBe(
      0,
    );
  });

  it('cena z przecinkiem dziesietnym, bo tak sie ja pisze po polsku', () => {
    expect(
      filtryZZapytania({ cenaOd: '74,90' }, ['pro', 'swietlik', 'allegro_swietlik', 'allegro_polcien2']).cenaOd,
    ).toBe(7490);
    expect(
      filtryZZapytania({ cenaOd: '74.90' }, ['pro', 'swietlik', 'allegro_swietlik', 'allegro_polcien2']).cenaOd,
    ).toBe(7490);
  });

  it('cena, ktorej nie umiemy przeliczyc, spada do braku filtru zamiast wywalac ekran', () => {
    // `groszeZKwoty` RZUCA na niezrozumialej kwocie i tak ma zostac — to sa pieniadze
    // zapisywane do bazy. Ale tutaj kwota przychodzi z paska adresu, wiec literowka ma
    // pokazac liste, a nie pieciusetke.
    for (const zla of ['abc', '10zl', '1e5', '-5', '10.', 'NaN', '99 99']) {
      expect(
        filtryZZapytania({ cenaOd: zla }, ['pro', 'swietlik', 'allegro_swietlik', 'allegro_polcien2']).cenaOd,
      ).toBe(null);
      expect(
        filtryZZapytania({ cenaDo: zla }, ['pro', 'swietlik', 'allegro_swietlik', 'allegro_polcien2']).cenaDo,
      ).toBe(null);
    }
  });

  it('nieznana wartosc filtru jest odrzucana, nie przekazywana dalej', () => {
    expect(
      filtryZZapytania({ kanal: 'sklep-ktorego-nie-ma' }, ['pro', 'swietlik', 'allegro_swietlik', 'allegro_polcien2'])
        .kanal,
    ).toBe(null);
    expect(
      filtryZZapytania({ brak: 'cokolwiek' }, ['pro', 'swietlik', 'allegro_swietlik', 'allegro_polcien2']).brak,
    ).toBe(null);
    // Z listą definicji (ekran) parametr spoza niej zostaje numerem — baza odda pusto, nie cały katalog.
    expect(filtryZZapytania({ parametr: '99' }, KANALY_MAGAZYNU, []).parametr).toBe('99');
  });

  it('nazwa z lancucha prototypow nie przechodzi przez zadna z bialych list', () => {
    // ⚠️ `LISTA[x] ?? domyslne` oddaje funkcje z `Object.prototype` — realna pieciusetka
    // zlapana na `?sort=constructor`. Filtry czytaja z tego samego adresu.
    for (const zly of ['constructor', 'toString', 'hasOwnProperty', '__proto__', 'valueOf']) {
      expect(filtryZZapytania({ kanal: zly }, ['pro', 'swietlik', 'allegro_swietlik', 'allegro_polcien2']).kanal).toBe(
        null,
      );
      expect(filtryZZapytania({ brak: zly }, ['pro', 'swietlik', 'allegro_swietlik', 'allegro_polcien2']).brak).toBe(
        null,
      );
      expect(filtryZZapytania({ parametr: zly }, KANALY_MAGAZYNU, []).parametr).toBe(null);
    }
  });

  it('powtorzony parametr adresu (tablica) nie leci dalej jako tablica', () => {
    // Fastify oddaje `?fraza=a&fraza=b` jako tablice. Tablica w LIKE albo w `=` konczy sie
    // wiazaniem, ktorego node:sqlite nie przyjmie — czyli pieciusetka z paska adresu.
    expect(
      filtryZZapytania({ fraza: ['a', 'b'] }, ['pro', 'swietlik', 'allegro_swietlik', 'allegro_polcien2']).fraza,
    ).toBe(null);
    expect(
      filtryZZapytania({ kanal: ['pro', 'swietlik'] }, ['pro', 'swietlik', 'allegro_swietlik', 'allegro_polcien2'])
        .kanal,
    ).toBe(null);
    expect(
      filtryZZapytania({ kategoria: ['Boho', 'Aplikacje'] }, [
        'pro',
        'swietlik',
        'allegro_swietlik',
        'allegro_polcien2',
      ]).kategoria,
    ).toBe(null);
    expect(
      filtryZZapytania({ cenaOd: ['10', '20'] }, ['pro', 'swietlik', 'allegro_swietlik', 'allegro_polcien2']).cenaOd,
    ).toBe(null);
  });

  it('fraza jest przycinana, a sama biel to brak frazy', () => {
    expect(
      filtryZZapytania({ fraza: '  szpulka  ' }, ['pro', 'swietlik', 'allegro_swietlik', 'allegro_polcien2']).fraza,
    ).toBe('szpulka');
    expect(filtryZZapytania({ fraza: '   ' }, ['pro', 'swietlik', 'allegro_swietlik', 'allegro_polcien2']).fraza).toBe(
      null,
    );
  });

  it('kategoria NIE ma zamknietej listy — nazwy przychodza ze sklepow', () => {
    // Odwrotnie niz kanaly: kategorie doklada SKLEP, bez pytania nas o zdanie (ta sama
    // asymetria, co przy metodach platnosci na liscie zamowien). Nazwa nietrafiona po prostu
    // nie trafi w zaden karta — i to jest inna sytuacja niz „wartosc spoza slownika".
    expect(
      filtryZZapytania({ kategoria: 'Kategoria, ktorej jeszcze nie ma' }, [
        'pro',
        'swietlik',
        'allegro_swietlik',
        'allegro_polcien2',
      ]).kategoria,
    ).toBe('Kategoria, ktorej jeszcze nie ma');
    expect(
      filtryZZapytania({ kategoria: '  Boho  ' }, ['pro', 'swietlik', 'allegro_swietlik', 'allegro_polcien2'])
        .kategoria,
    ).toBe('Boho');
    expect(
      filtryZZapytania({ kategoria: '' }, ['pro', 'swietlik', 'allegro_swietlik', 'allegro_polcien2']).kategoria,
    ).toBe(null);
  });
});

// ⚠️⚠️ FILTR BRAKÓW. Warstwa zapytan zna piec stalych brakow: sku, wymiary,
// kategoria, zdjecie, opis — i `parametr-<id>` dla kazdego wymaganego parametru karty. Nieobsługiwana wartość `brak ∈ sku|wymiary|allegro` — wartosci
// `allegro` w `db/magazyn.js` NIE MA i nieznana wartosc leci tam w `1 = 0`. Pozycja
// „bez oferty na Allegro" wystawiona w interfejsie oddawalaby wiec PUSTA LISTE przy kazdym
// klknieciu, co wyglada jak „nie ma takich kart", a nie jak funkcja, ktorej nie napisano.
describe('slowniki filtrow zgadzaja sie z warstwa zapytan', () => {
  let db;
  beforeEach(() => {
    db = openOmsDb(':memory:');
  });

  // ⚠️ KAZDEJ KARCIE BRAKUJE DOKLADNIE JEDNEJ RZECZY, i kazdej innej.
  //
  // Wczesniej stala tu jedna karta „Niepelna" bez NICZEGO — a wtedy wszystkie cztery pozycje
  // `brak` oddawaly ten sam wiersz i test nie odrozial ich od siebie: podmiana galezi
  // `brak === 'sku'` na warunek o wymiarach przechodzila na zielono. Wlasciwosc byla
  // GWARANTOWANA USTAWIENIEM ATRAPY, a nie sprawdzana — ta sama rodzina, co produkt
  // zawsze powiazany z kartą.
  //
  // ⚠️ SIODMA POZYCJA (`komplet`) NIE JEST BRAKIEM, tylko druga strona tej samej monety:
  // karty, ktorym NICZEGO nie brakuje. W tym katalogu jest to dokladnie jeden wiersz, wiec
  // rozjechanie sie jej z warstwa zapytan pada tak samo jak przy sześciu pozostalych.
  const KARTA_POZYCJI = Object.freeze({
    sku: 'BezSku',
    wymiary: 'BezWymiarow',
    kategoria: 'BezKategorii',
    paczkomat: 'BezPaczkomatu',
    zdjecie: 'BezZdjecia',
    opis: 'BezOpisu',
    cena_zakupu: 'BezCenyZakupu',
    komplet: 'Komplet',
  });
  // Cena zakupu NIE jest warunkiem kompletu: karta, ktorej brakuje tylko ceny, jest kompletna.
  // Gdyby cena weszla do liczby brakow, kafel postepu spadlby do zera w dniu wprowadzenia ceny.
  const KOMPLETNE = ['BezCenyZakupu', 'Komplet'];
  const wszystkieCeny = () => db.prepare('DELETE FROM ceny_zakupu_kart').run();

  function katalog() {
    // `karty.sku` ma UNIQUE, wiec kazda karta dostaje wlasny numer — inaczej atrapa wysypuje
    // sie na wiezie, zamiast opisac katalog.
    const pelny = (nazwa) => ({
      nazwa,
      sku: `SKU-${nazwa}`,
      szerokosc_mm: 700,
      wysokosc_mm: 1000,
      kategoria_glowna: 'Boho',
    });
    // „Paczkomat" to tu wymagany parametr karty: jego brak liczy sie tak samo jak brak pola stalego.
    const paczkomat = dodajParametr(db, {
      nazwa: 'Paczkomat',
      typ: 'lista',
      wartosci: ['tak', 'nie'],
      wymagany: true,
    }).id;
    const bez = {
      sku: { sku: null },
      // Polowiczny wymiar to nadal brak wymiarow — do wysylki i gabarytu potrzebne sa oba.
      wymiary: { wysokosc_mm: null },
      kategoria: { kategoria_glowna: null },
      paczkomat: {},
      zdjecie: {},
      opis: {},
      cena_zakupu: {},
    };
    const uzupelnijTresc = (id, brak) => {
      if (brak !== 'opis')
        db.prepare('UPDATE karty_produktow SET opis_sekcje_json = ? WHERE id = ?').run(
          JSON.stringify({ sekcje: [{ elementy: [{ typ: 'tekst', html: '<p>Opis karty</p>' }] }] }),
          id,
        );
      if (brak !== 'zdjecie')
        db.prepare(
          `INSERT INTO zdjecia_kart
        (karta_id, kolejnosc, zrodlo, adres_zrodlowy, utworzono_at)
        VALUES (?, 0, 'reczne', 'https://example.org/karta.png', '2026-11-13')`,
        ).run(id);
    };
    // ⚠️ `komplet` z KARTA_POZYCJI wlasna karta nie jest — to TA karta, ktora ma komplet.
    const komplet = utworzKarte(db, pelny(KARTA_POZYCJI.komplet));
    uzupelnijTresc(komplet);
    const cena = (id) => zapiszCeneZakupu(db, id, { gr: 1000, od: '2020-01-01' }, { zrodlo: 'karta' });
    cena(komplet);
    ustawWartoscKarty(db, komplet, paczkomat, 'tak');
    for (const [brak, dziura] of Object.entries(bez)) {
      const id = utworzKarte(db, { ...pelny(KARTA_POZYCJI[brak]), ...dziura });
      uzupelnijTresc(id, brak);
      if (brak !== 'cena_zakupu') cena(id);
      if (brak !== 'paczkomat') ustawWartoscKarty(db, id, paczkomat, 'tak');
    }
    // Dwa produkty w lustrze, w roznych kanalach — zeby „filtr zawezil" znaczylo cos wiecej
    // niz „filtr czegos nie wywalil".
    for (const [kartaId, kanal, produktId] of [[komplet, 'pro', '1']]) {
      const p = zapiszProduktSklepowy(db, {
        kanal,
        produkt_id: produktId,
        wariant_id: '',
        cena_gr: 5000,
        nazwa: `Produkt ${produktId}`,
        odczytane_at: '2026-08-11T06:00:00.000Z',
      });
      powiazProdukt(db, p, kartaId);
    }
    return { paczkomat };
  }

  it('KAZDA pozycja z BRAKI_MAGAZYNU zaweza do SWOJEJ karty, a nie do „byle niepelnej"', () => {
    const { paczkomat } = katalog();
    expect(kartyZKanalami(db, {})).toHaveLength(8);

    // Brak wymaganego parametru stoi obok stalych pozycji slownika i tez trafia w swoja karte.
    const oczekiwane = (brak) => {
      if (brak === 'komplet') return KOMPLETNE;
      if (brak === kluczBrakuParametru(paczkomat)) return [KARTA_POZYCJI.paczkomat];
      return [KARTA_POZYCJI[brak]];
    };
    for (const brak of [...BRAKI_MAGAZYNU, kluczBrakuParametru(paczkomat)]) {
      const wynik = kartyZKanalami(db, { filtry: { brak } });
      // Pozycja nieznana bazie oddalaby ZERO na kazdym katalogu. A ze kazdej karcie
      // brakuje CZEGOS INNEGO, przestawienie dwoch galezi miedzy soba tez tu pada.
      expect(wynik.map((w) => w.nazwa).sort(), `brak=${brak}`).toEqual(oczekiwane(brak));
    }
  });

  // ⚠️ SIODMA POZYCJA JEST KAFLEM POSTEPU, a kafel PROWADZI do listy. Gdyby `komplet` zostalo
  // dopisane do slownika, a warstwa zapytan go nie znala, kafel „gotowe: 214" prowadzilby
  // do PUSTEJ tabeli — czyli do obrazu „nie ma takich kart" przy 214 kartach, ktore sa.
  it('komplet jest pozycja slownika, ma etykiete i baza go rozumie', () => {
    katalog();
    expect(BRAKI_MAGAZYNU).toContain('komplet');
    expect(BRAKI_ETYKIETY.komplet).toBe('komplet — nic nie brakuje');
    expect(
      filtryZZapytania({ brak: 'komplet' }, ['pro', 'swietlik', 'allegro_swietlik', 'allegro_polcien2']).brak,
    ).toBe('komplet');
    // Sześć niepelnych kart z `katalog()` ma tu NIE BYC — inaczej „komplet" znaczyloby
    // „cokolwiek", a hurt puszczony po tym zawezeniu ruszylby caly katalog.
    expect(
      kartyZKanalami(db, { filtry: { brak: 'komplet' } })
        .map((w) => w.nazwa)
        .sort(),
    ).toEqual(KOMPLETNE);
  });

  it('bez ceny zakupu: liczy sie cena obowiazujaca DZIS, przyszla nie wystarcza', () => {
    katalog();
    expect(BRAKI_MAGAZYNU.indexOf('cena_zakupu')).toBe(BRAKI_MAGAZYNU.length - 2);
    expect(BRAKI_ETYKIETY.cena_zakupu).toBe('bez ceny zakupu');
    expect(filtryZZapytania({ brak: 'cena_zakupu' }, KANALY_MAGAZYNU).brak).toBe('cena_zakupu');

    const przyszla = utworzKarte(db, { nazwa: 'TylkoPrzyszla', sku: 'SKU-TylkoPrzyszla' });
    zapiszCeneZakupu(db, przyszla, { gr: 2000, od: '2099-01-01' }, { zrodlo: 'karta' });
    const nazwy = () =>
      kartyZKanalami(db, { filtry: { brak: 'cena_zakupu' } })
        .map((w) => w.nazwa)
        .sort();
    expect(nazwy()).toEqual(['BezCenyZakupu', 'TylkoPrzyszla']);

    // Cena z dniem „od" rownym dzisiejszemu juz obowiazuje (`<=`).
    zapiszCeneZakupu(db, przyszla, { gr: 1900, od: dzienWarszawa(new Date().toISOString()) }, { zrodlo: 'karta' });
    expect(nazwy()).toEqual(['BezCenyZakupu']);
  });

  it('cena zakupu nie wchodzi do kafla kompletu: skasowanie wszystkich cen go nie rusza', () => {
    katalog();
    const przed = zliczeniaBrakow(db);
    expect(przed.komplet).toBe(2);
    wszystkieCeny();
    expect(zliczeniaBrakow(db)).toEqual(przed);
    expect(kartyZKanalami(db, { filtry: { brak: 'cena_zakupu' } })).toHaveLength(8);
  });

  // Pole wyboru filtru sklada trasa jako `BRAKI_MAGAZYNU.map(k => ({k, BRAKI_ETYKIETY[k]}))`,
  // wiec pozycja bez etykiety renderuje sie jako PUSTY wiersz listy rozwijanej — widoczny,
  // klikalny i nie do nazwania.
  it('KAZDA pozycja slownika ma etykiete, bo z nich powstaje pole wyboru', () => {
    for (const brak of BRAKI_MAGAZYNU) {
      expect(BRAKI_ETYKIETY[brak], `etykieta dla brak=${brak}`).toBeTruthy();
    }
    expect(Object.keys(BRAKI_ETYKIETY).sort()).toEqual([...BRAKI_MAGAZYNU].sort());
  });

  it('pozycja SPOZA slownika oddaje pusto — i wlasnie dlatego slownik musi sie zgadzac', () => {
    katalog();
    // Strażnik milczy wyżej i alarmuje tutaj. `allegro` jest wartością
    // tego drugiego rodzaju — dlatego nie ma go w BRAKI_MAGAZYNU.
    expect(BRAKI_MAGAZYNU).not.toContain('allegro');
    expect(kartyZKanalami(db, { filtry: { brak: 'allegro' } })).toEqual([]);
    expect(
      filtryZZapytania({ brak: 'allegro' }, ['pro', 'swietlik', 'allegro_swietlik', 'allegro_polcien2']).brak,
    ).toBe(null);
  });

  it('KAZDY kanal ze slownika zaweza do SWOJEJ karty, a nie do „byle majacej produkt"', () => {
    // ⚠️ Wczesniej stala tu JEDNA karta obecna we WSZYSTKICH czterech kanalach i druga bez
    // produktu — a wtedy filtr, ktory w ogole nie patrzy na wartosc `kanal`, oddawal ten sam
    // wynik i test swiecil na zielono. Wlasciwosc byla gwarantowana atrapa. Teraz kazdy
    // kanal ma WLASNA karte, wiec pominiecie wartosci kanalu oddaje cztery wiersze zamiast
    // jednego.
    KANALY_MAGAZYNU.forEach((kanal, i) => {
      const kartaId = utworzKarte(db, { nazwa: `Tylko ${kanal}` });
      const p = zapiszProduktSklepowy(db, {
        kanal,
        produkt_id: String(100 + i),
        wariant_id: '',
        cena_gr: 1000,
        nazwa: `Tylko ${kanal}`,
        odczytane_at: '2026-08-11T06:00:00.000Z',
      });
      powiazProdukt(db, p, kartaId);
    });
    utworzKarte(db, { nazwa: 'Nigdzie' });

    for (const kanal of KANALY_MAGAZYNU) {
      expect(
        kartyZKanalami(db, { filtry: { kanal } }).map((w) => w.nazwa),
        kanal,
      ).toEqual([`Tylko ${kanal}`]);
    }
  });

  // Wartości parametru listy przechodzą przez parser ekranu (z listą definicji) i trafiają
  // w swoją kartę; „bez wartości" to trzeci, osobny stan, a nie „nie".
  it('KAZDA wartosc parametru listy i „bez wartosci" zaweza liste do swojej karty', () => {
    const p = dodajParametr(db, { nazwa: 'Paczkomat', typ: 'lista', wartosci: ['tak', 'nie'], wymagany: true }).id;
    ustawWartoscKarty(db, utworzKarte(db, { nazwa: 'Atak' }), p, 'tak');
    ustawWartoscKarty(db, utworzKarte(db, { nazwa: 'Bnie' }), p, 'nie');
    utworzKarte(db, { nazwa: 'Cbrak' });
    const parametry = listaParametrow(db);
    const nazwy = (q) =>
      kartyZKanalami(db, { filtry: filtryZZapytania({ parametr: String(p), ...q }, KANALY_MAGAZYNU, parametry) }).map(
        (w) => w.nazwa,
      );

    expect(nazwy({ pw: 'tak' })).toEqual(['Atak']);
    expect(nazwy({ pw: 'nie' })).toEqual(['Bnie']);
    expect(nazwy({ pbez: '1' })).toEqual(['Cbrak']);
    // Wartość spoza listy nie trafia w nic — pusty ekran, nie cały katalog.
    expect(nazwy({ pw: 'moze' })).toEqual([]);
  });

  it('wartosc przepuszczona przez parser jest wartoscia, ktora baza rozumie', () => {
    katalog();
    // Petla po WSZYSTKICH pozycjach kazdego slownika naraz: parser ma je przepuscic,
    // a zapytanie ma je zrozumiec. Dopisanie pozycji do jednej strony bez drugiej pada tu.
    for (const [pole, wartosci] of [
      ['kanal', KANALY_MAGAZYNU],
      ['brak', BRAKI_MAGAZYNU],
    ]) {
      for (const w of wartosci) {
        expect(
          filtryZZapytania({ [pole]: w }, ['pro', 'swietlik', 'allegro_swietlik', 'allegro_polcien2'])[pole],
          `${pole}=${w}`,
        ).toBe(w);
      }
    }
  });
});

describe('saJakiesFiltry', () => {
  it('milczy przy pustym komplecie', () => {
    expect(saJakiesFiltry(filtryZZapytania({}, ['pro', 'swietlik', 'allegro_swietlik', 'allegro_polcien2']))).toBe(
      false,
    );
    expect(saJakiesFiltry({})).toBe(false);
    expect(saJakiesFiltry(null)).toBe(false);
  });

  it('alarmuje na KAZDYM pojedynczym filtrze z osobna', () => {
    // Po jednym na pole: pominiete pole w sumie logicznej znaczy „ekran twierdzi, ze nic
    // nie zawezil", czyli pusty wynik filtrowania opisuje sie jako pusty magazyn.
    for (const q of [
      { fraza: 'szpulka' },
      { kanal: 'pro' },
      { kategoria: 'Boho' },
      { brak: 'sku' },
      { parametr: '3' },
      { cenaOd: '10' },
      { cenaDo: '10' },
    ]) {
      expect(
        saJakiesFiltry(filtryZZapytania(q, ['pro', 'swietlik', 'allegro_swietlik', 'allegro_polcien2'])),
        JSON.stringify(q),
      ).toBe(true);
    }
  });

  it('cena zerowa TEZ jest filtrem — zero to wartosc, nie brak', () => {
    expect(
      saJakiesFiltry(filtryZZapytania({ cenaOd: '0' }, ['pro', 'swietlik', 'allegro_swietlik', 'allegro_polcien2'])),
    ).toBe(true);
  });
});

describe('parametryUkryte — formularze niosa nawzajem swoje wartosci', () => {
  // ⚠️ SEDNO. Prosba wlasciciela przy liscie zamowien brzmiala: „chce poszukac klienta
  // i wyswietlic jego zamowienia z okreslonego czasu". Tu jest tak samo: fraza i filtry
  // musza sie LACZYC. Formularz GET wysyla TYLKO wlasne pola, wiec kazdy z dwoch
  // formularzy musi niesc wartosci drugiego ukrytymi polami.
  it('formularz filtrow niesie dalej fraze', () => {
    expect(parametryUkryte({ fraza: 'szpulka', kanal: 'pro' })).toContainEqual({ name: 'fraza', value: 'szpulka' });
  });

  it('formularz wyszukiwarki niesie dalej filtry', () => {
    const u = parametryUkryte({ fraza: null, kanal: 'pro', brak: 'sku' });
    expect(u).toContainEqual({ name: 'kanal', value: 'pro' });
    expect(u).toContainEqual({ name: 'brak', value: 'sku' });
  });

  it('pustych wartosci nie przenosi — inaczej adres puchnie o puste parametry', () => {
    expect(parametryUkryte({ fraza: null, kanal: null })).toEqual([]);
    expect(parametryUkryte({})).toEqual([]);
  });

  it('⚠️ cena wraca ZLOTOWKAMI, a nie groszami — inaczej kazde kliknięcie mnozy ja przez sto', () => {
    // Filtry trzymamy w groszach (tego chce baza), a pole formularza mowi zlotowkami.
    // Przepisanie surowej wartosci do ukrytego pola zamienia „od 10 zl" w „od 1000 zl"
    // przy pierwszym klknieciu w naglowek sortujacy, a w „od 100 000 zl" przy drugim.
    const u = parametryUkryte(
      filtryZZapytania({ cenaOd: '10', cenaDo: '74,90' }, ['pro', 'swietlik', 'allegro_swietlik', 'allegro_polcien2']),
    );
    expect(u).toContainEqual({ name: 'cenaOd', value: '10.00' });
    expect(u).toContainEqual({ name: 'cenaDo', value: '74.90' });
  });

  it('obrot przez ukryte pole nie rusza zadnej wartosci (dwa razy tam i z powrotem)', () => {
    const pierwsze = filtryZZapytania(
      {
        fraza: 'szpulka',
        kanal: 'pro',
        kategoria: 'Boho',
        brak: 'sku',
        parametr: '3',
        pbez: '1',
        cenaOd: '10',
        cenaDo: '74,90',
      },
      ['pro', 'swietlik', 'allegro_swietlik', 'allegro_polcien2'],
    );
    const jakZapytanie = (pary) => Object.fromEntries(pary.map((p) => [p.name, p.value]));
    const drugie = filtryZZapytania(jakZapytanie(parametryUkryte(pierwsze)), [
      'pro',
      'swietlik',
      'allegro_swietlik',
      'allegro_polcien2',
    ]);
    const trzecie = filtryZZapytania(jakZapytanie(parametryUkryte(drugie)), [
      'pro',
      'swietlik',
      'allegro_swietlik',
      'allegro_polcien2',
    ]);

    expect(drugie).toEqual(pierwsze);
    expect(trzecie).toEqual(pierwsze);
  });

  it('formularz nie wysyla wlasnego pola DWA RAZY', () => {
    // ⚠️ Plan mowil „oba formularze renderuja parametryUkryte(filtry)" — doslownie wzięte
    // znaczyloby, ze formularz filtrow wysyla `kanal` ukrytym polem I polem wyboru naraz.
    // Fastify oddaje wtedy TABLICE, parser slusznie odrzuca ja do `null` i filtr znika
    // dokladnie w tym formularzu, ktory sluzy do jego ustawiania.
    const filtry = filtryZZapytania({ fraza: 'szpulka', kanal: 'pro', cenaOd: '10' }, [
      'pro',
      'swietlik',
      'allegro_swietlik',
      'allegro_polcien2',
    ]);
    const u = parametryUkryte(filtry, {
      pomin: ['kanal', 'kategoria', 'brak', 'parametr', 'pw', 'pod', 'pdo', 'pbez', 'cenaOd', 'cenaDo'],
    });

    expect(u).toEqual([{ name: 'fraza', value: 'szpulka' }]);
    expect(parametryUkryte(filtry, { pomin: ['fraza'] }).map((p) => p.name)).not.toContain('fraza');
  });
});

describe('wartosciPol — to, co stoi w polach formularza', () => {
  it('cena w polu jest ZLOTOWKA, tak jak ja wpisano', () => {
    const w = wartosciPol(
      filtryZZapytania({ cenaOd: '10', cenaDo: '74,90' }, ['pro', 'swietlik', 'allegro_swietlik', 'allegro_polcien2']),
    );
    // `value="1000"` przy „od 10 zl" utrwaliloby setke jako nowa wartosc filtru przy
    // pierwszym klknieciu „Filtruj" — po cichu, bo obie postacie sa poprawnymi liczbami.
    expect(w.cenaOd).toBe('10.00');
    expect(w.cenaDo).toBe('74.90');
  });

  it('brak wartosci to PUSTY NAPIS, a nie „null" do skasowania recznie', () => {
    const w = wartosciPol(filtryZZapytania({}, ['pro', 'swietlik', 'allegro_swietlik', 'allegro_polcien2']));
    for (const klucz of [
      'fraza',
      'kanal',
      'kategoria',
      'brak',
      'parametr',
      'pw',
      'pod',
      'pdo',
      'pbez',
      'cenaOd',
      'cenaDo',
    ]) {
      expect(w[klucz], klucz).toBe('');
    }
  });

  it('przepisuje pozostale pola bez zmiany', () => {
    const w = wartosciPol(
      filtryZZapytania(
        {
          fraza: 'szpulka',
          kanal: 'pro',
          kategoria: 'Boho',
          brak: 'sku',
          parametr: '3',
          pbez: '1',
        },
        ['pro', 'swietlik', 'allegro_swietlik', 'allegro_polcien2'],
      ),
    );
    expect(w).toMatchObject({
      fraza: 'szpulka',
      kanal: 'pro',
      kategoria: 'Boho',
      brak: 'sku',
      parametr: '3',
      pbez: '1',
    });
  });
});

describe('adresMagazynu — filtry przezywaja klikniecie w naglowek sortujacy', () => {
  it('zachowuje fraze i KAZDY filtr przy zmianie sortowania', () => {
    const filtry = filtryZZapytania(
      {
        fraza: 'szpulka',
        kanal: 'pro',
        kategoria: 'Boho',
        brak: 'sku',
        parametr: '3',
        pbez: '1',
        cenaOd: '10',
        cenaDo: '99',
      },
      ['pro', 'swietlik', 'allegro_swietlik', 'allegro_polcien2'],
    );
    const adres = adresMagazynu(filtry, { sort: 'sku', kier: 'desc' });

    expect(adres.startsWith('/magazyn?')).toBe(true);
    const q = new URLSearchParams(adres.slice(adres.indexOf('?') + 1));
    expect(Object.fromEntries(q)).toEqual({
      fraza: 'szpulka',
      kanal: 'pro',
      kategoria: 'Boho',
      brak: 'sku',
      parametr: '3',
      pbez: '1',
      cenaOd: '10.00',
      cenaDo: '99.00',
      sort: 'sku',
      kier: 'desc',
    });
  });

  it('adres bez filtrow niesie samo sortowanie — „Wyczysc" nie gubi kolejnosci', () => {
    expect(adresMagazynu({}, { sort: 'wysokosc', kier: 'desc' })).toBe('/magazyn?sort=wysokosc&kier=desc');
  });

  it('koduje znaki, ktore inaczej rozbilyby adres na dwa parametry', () => {
    const adres = adresMagazynu(
      filtryZZapytania({ fraza: 'a&kanal=swietlik' }, ['pro', 'swietlik', 'allegro_swietlik', 'allegro_polcien2']),
      { sort: 'nazwa', kier: 'asc' },
    );
    expect(adres).not.toContain('a&kanal=swietlik');
    const q = new URLSearchParams(adres.slice(adres.indexOf('?') + 1));
    expect(q.get('fraza')).toBe('a&kanal=swietlik');
    expect(q.get('kanal')).toBe(null);
  });

  it('kolejnosc parametrow jest STALA — ten sam widok ma zawsze ten sam adres', () => {
    const a = adresMagazynu(
      filtryZZapytania({ kanal: 'pro', fraza: 'x' }, ['pro', 'swietlik', 'allegro_swietlik', 'allegro_polcien2']),
      { sort: 'nazwa', kier: 'asc' },
    );
    const b = adresMagazynu(
      filtryZZapytania({ fraza: 'x', kanal: 'pro' }, ['pro', 'swietlik', 'allegro_swietlik', 'allegro_polcien2']),
      { sort: 'nazwa', kier: 'asc' },
    );
    expect(a).toBe(b);
  });

  // ——— TRYB KOLUMN TABELI ———————————————————————
  //
  // ⚠️ TRYB JEDZIE ADRESEM, bo panel nie ma JavaScriptu — przelacznik kolumn to zwykly
  // odnosnik, wiec musi sie skladac TAM, GDZIE KAZDY inny odnosnik ekranu (niezmiennik
  // 4.13b). Gdyby powstawal osobno, przelaczenie trybu kasowaloby zawezenie i kolejnosc.
  it('tryb tabeli jedzie adresem WYLACZNIE wtedy, gdy nie jest domyslny', () => {
    expect(adresMagazynu({}, { widok: 'katalog' })).toBe('/magazyn?widok=katalog');
    // ⚠️ DOMYSLNY NIE ZASMIECA ADRESU: „/magazyn" i „/magazyn?widok=porzadki" bylyby dwoma
    // adresami JEDNEJ rzeczy (historia przegladarki, zakladki, porownanie w tescie).
    expect(adresMagazynu({}, { widok: 'porzadki' })).toBe('/magazyn');
    expect(adresMagazynu({}, {})).toBe('/magazyn');
    // Wartosc spoza pary tez nie ma prawa wejsc do adresu — biala lista jest w trasie,
    // ale ta funkcja nie ma prawa przepuscic niczego innego niz „katalog".
    expect(adresMagazynu({}, { widok: 'constructor' })).toBe('/magazyn');
  });

  it('tryb stoi PO kolejnosci, a PRZED zaznaczeniem — kolejnosc pol jest stala', () => {
    expect(
      adresMagazynu(
        {},
        {
          sort: 'braki',
          kier: 'desc',
          widok: 'katalog',
          zaznacz: true,
        },
      ),
    ).toBe('/magazyn?sort=braki&kier=desc&widok=katalog&zaznacz=1');
  });

  it('tryb doklada sie do PELNEGO kompletu, a nie zastepuje go', () => {
    const filtry = filtryZZapytania({ fraza: 'szpulka', kanal: 'pro', brak: 'sku' }, [
      'pro',
      'swietlik',
      'allegro_swietlik',
      'allegro_polcien2',
    ]);
    const adres = adresMagazynu(filtry, { sort: 'braki', kier: 'desc', widok: 'katalog' });
    const q = new URLSearchParams(adres.slice(adres.indexOf('?') + 1));

    expect(Object.fromEntries(q)).toEqual({
      fraza: 'szpulka',
      kanal: 'pro',
      brak: 'sku',
      sort: 'braki',
      kier: 'desc',
      widok: 'katalog',
    });
  });
});
